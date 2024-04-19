#!/usr/bin/env node
const {program} = require('commander');
const {start, stop} = require('./commands');

program
  .name('smoko')
  .description('An easy way to give CloudFront served content a break.')
;

program.command('start')
  .argument('<distribution-id>', 'CloudFront distribution ID')
  .option('-c, --content <string>', 'maintenance page content')
  .option('-f, --file <string>', 'maintenance page file path')
  .option('-j, --json', 'output json instead of text')
  .option('-q, --quiet', 'silence info logs')
  .action(start)
;

program.command('stop')
  .option('-j, --json', 'output json instead of text')
  .option('-q, --quiet', 'silence info logs')
  .action(stop)
;

program.parseAsync();
