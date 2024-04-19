const {CloudFrontClient, CreateInvalidationCommand, GetDistributionCommand, GetDistributionConfigCommand, GetInvalidationCommand, UpdateDistributionCommand} = require('@aws-sdk/client-cloudfront');
const {IAMClient, AttachRolePolicyCommand, CreateRoleCommand, GetRoleCommand, NoSuchEntityException} = require("@aws-sdk/client-iam");
const {LambdaClient, CreateFunctionCommand, GetFunctionCommand, ResourceNotFoundException, UpdateFunctionCodeCommand} = require("@aws-sdk/client-lambda");
const {readFileSync} = require('fs');
const ZipStream = require('zip-stream');

const LAMBDA_ROLE = 'smoko-lambda';
const LAMBDA_PREFIX = 'smoko-';

const iamClient = new IAMClient();
const cfClient = new CloudFrontClient();
const ldClient = new LambdaClient({region: 'us-east-1'});

function info(options, message) {
  if (options.quiet) {
    return;
  }

  console.info(`[${new Date().toISOString()}] ${message}`);
}

function respond(options, response) {
  const atString = new Date().toISOString();

  if (options.json) {
    console.log({...response, at: atString});

    return;
  }

  if (!response.completed) {
    console.error(`[${atString}] Failed!`);
  }
  console.log(`[${atString}] ${response.message}`);
}

function streamToBuffer(stream) {
  const chunks = [];
  return new Promise(function (resolve, reject) {
    stream.on('data', function (chunk) { chunks.push(Buffer.from(chunk)) });
    stream.on('error', function (err) { reject(err); });
    stream.on('end', function () { resolve(Buffer.concat(chunks)); });
  })
}

async function getRoleArn(role) {
  try {
    const response = await iamClient.send(new GetRoleCommand({RoleName: role}));
    return response.Role.Arn;
  } catch (err) {
    if (!(err instanceof NoSuchEntityException)) {
      throw err;
    }
    return null;
  }
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function waitForLambdaActive(lambdaArn) {
  let i = 0;
  while (i < 120) {
    const response = await ldClient.send(new GetFunctionCommand({
      FunctionName: lambdaArn,
    }));

    if (response.Configuration.State === 'Active') {
      return true;
    }

    await sleep(500);

    ++i;
  }

  throw new Error(`Lambda (ARN: ${lambdaArn}) never became active.`);
}

async function ensureLambda(cloudFrontDistributionId, content) {
  let roleArn = await getRoleArn(LAMBDA_ROLE);
  if (!roleArn) {
    const roleCreateResponse = await iamClient.send(new CreateRoleCommand({
      RoleName: LAMBDA_ROLE,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: ['edgelambda.amazonaws.com', 'lambda.amazonaws.com']
            },
            Action: ['sts:AssumeRole']
          }
        ]
      }),
    }));
    roleArn = roleCreateResponse.Role.Arn;

    await iamClient.send(new AttachRolePolicyCommand({
      RoleName: LAMBDA_ROLE,
      PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
    }));
  }

  const lambdaContent = `
    exports.handler = async function () {
      return {
        status: '504',
        headers: {
          'retry-after': [{value: '60'}]
        },
        body: ${JSON.stringify(content || '')},
      };
    };
  `;

  const archive = new ZipStream();
  archive.entry(lambdaContent, {name: 'index.js'}, function(err) {
    if (err) throw err;
    archive.finish();
  });
  const ZipFile = await streamToBuffer(archive);

  let response = null;
  const FunctionName = `${LAMBDA_PREFIX}-${cloudFrontDistributionId}`;
  try {
    await ldClient.send(new GetFunctionCommand({
      FunctionName,
    }));

    response = await ldClient.send(new UpdateFunctionCodeCommand({
      FunctionName,
      ZipFile,
      Publish: true,
    }));
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) {
      throw err;
    }

    response = await ldClient.send(new CreateFunctionCommand({
      FunctionName,
      Runtime: 'nodejs18.x',
      Role: roleArn,
      Handler: 'index.handler',
      Code: {
        ZipFile,
      },
      Publish: true,
      PackageType: 'Zip',
    }));
  }

  let versionedArn = response.FunctionArn;
  const versionSuffix = `:${response.Version}`;
  if (!versionedArn.endsWith(versionSuffix)) {
    versionedArn += versionSuffix;
  }

  await waitForLambdaActive(versionedArn);

  return versionedArn;
}

async function waitForDistributionDeployed(cloudFrontDistributionId) {
  let i = 0;
  while (i < 600) {
    const response = await cfClient.send(new GetDistributionCommand({
      Id: cloudFrontDistributionId,
    }));

    if (response.Distribution.Status === 'Deployed') {
      return true;
    }

    await sleep(500);

    ++i;
  }

  throw new Error(`Distribution (id: ${cloudFrontDistributionId}) never finished deploying.`);
}

async function invalidate(cloudFrontDistributionId, path = '/*', waitUntilComplete = false) {
  const createResponse = await cfClient.send(new CreateInvalidationCommand({
    DistributionId: cloudFrontDistributionId,
    InvalidationBatch: {
      Paths: {
        Quantity: 1,
        Items: [
          path,
        ],
      },
      CallerReference: new Date().getTime(),
    },
  }));
  const invalidationId = createResponse.Invalidation.Id;

  if (waitUntilComplete) {
    let i = 0;
    while (i < 120) {
      const response = await cfClient.send(new GetInvalidationCommand({
        DistributionId: cloudFrontDistributionId,
        Id: invalidationId,
      }));

      if (response.Invalidation.Status === 'Completed') {
        return true;
      }

      await sleep(500);

      ++i;
    }

    throw new Error(`Invalidation (id: ${invalidationId}) never finished.`);
  }
}

async function start() {
  const cloudFrontDistributionId = this.args[0];
  const options = this.opts();

  let content = options.content;
  if (options.file) {
    if (content) {
      throw new Error('Only one of content or file should be specified, which do you want?');
    }

    content = readFileSync(options.file, 'utf8');
  }
  if (!content) {
    console.warn(`[${new Date().toISOString()}] Warning, maintenance page is blank.`);
    await sleep(1000);
  }

  const lambdaArn = await ensureLambda(cloudFrontDistributionId, content);

  const {DistributionConfig, ETag} = await cfClient.send(new GetDistributionConfigCommand({
    Id: cloudFrontDistributionId,
  }));

  let lambdaItems = [];
  if (DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations.Items) {
    lambdaItems = [...DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations.Items];
  }

  let alreadyOn = false;
  if (lambdaItems.length) {
    const firstLambdaItem = lambdaItems[0];
    if (firstLambdaItem.EventType === 'viewer-request' && firstLambdaItem.LambdaFunctionARN.includes('function:smoko-')) {
      alreadyOn = true;
    }
  }

  if (!alreadyOn) {
    lambdaItems.unshift({
      LambdaFunctionARN: lambdaArn,
      EventType: 'viewer-request',
      IncludeBody: false,
    });

    await cfClient.send(new UpdateDistributionCommand({
      Id: cloudFrontDistributionId,
      IfMatch: ETag,
      DistributionConfig: {
        ...DistributionConfig,
        DefaultCacheBehavior: {
          ...DistributionConfig.DefaultCacheBehavior,
          LambdaFunctionAssociations: {
            Quantity: lambdaItems.length,
            Items: lambdaItems,
          },
        },
      },
    }));

    info(options, 'Distribution update started.');
  }

  await waitForDistributionDeployed(cloudFrontDistributionId);

  info(options, 'Distribution is deployed.');

  // This only needs to be complete by the time we're off smoko
  // but we might as well start it now since the cache is both
  // inaccessible and not written to while we're on smoko.
  await invalidate(cloudFrontDistributionId);

  info(options, 'Cache invalidation started.');

  const message = alreadyOn ?
    `${cloudFrontDistributionId} was already on smoko, content updated.` :
    `${cloudFrontDistributionId} is on smoko.`;

  return respond(options, {
    completed: true,
    message,
  });
}

async function stop() {
  const cloudFrontDistributionId = this.args[0];
  const options = this.opts();

  const {DistributionConfig, ETag} = await cfClient.send(new GetDistributionConfigCommand({
    Id: cloudFrontDistributionId,
  }));

  let lambdaItemsOrig = [];
  if (DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations.Items) {
    lambdaItemsOrig = [...DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations.Items];
  }

  const lambdaItems = lambdaItemsOrig.filter(function (lambdaItem) {
    return lambdaItem.EventType !== 'viewer-request' || !lambdaItem.LambdaFunctionARN.includes('function:smoko-');
  });

  const isAlreadyOff = lambdaItems.length === lambdaItemsOrig.length;
  if (!isAlreadyOff) {
    await cfClient.send(new UpdateDistributionCommand({
      Id: cloudFrontDistributionId,
      IfMatch: ETag,
      DistributionConfig: {
        ...DistributionConfig,
        DefaultCacheBehavior: {
          ...DistributionConfig.DefaultCacheBehavior,
          LambdaFunctionAssociations: {
            Quantity: lambdaItems.length,
            Items: lambdaItems,
          },
        },
      },
    }));

    info(options, 'Distribution update started.');
  }

  await waitForDistributionDeployed(cloudFrontDistributionId);

  info(options, 'Distribution is deployed.');

  const message = isAlreadyOff ?
    `${cloudFrontDistributionId} was already off smoko.` :
    `${cloudFrontDistributionId} is off smoko.`;

  respond(options, {
    completed: true,
    message,
  });
}

module.exports = {
  start,
  stop,
};
