# smoko
*An easy way to give CloudFront served content a break.*

## start

```
Usage: smoko start [options] <distribution-id>

Arguments:
  distribution-id         CloudFront distribution ID

Options:
  -c, --content <string>  maintenance page content
  -f, --file <string>     maintenance page file path
  -j, --json              output json instead of text
  -q, --quiet             silence info logs
  -h, --help              display help for command
```

*Example*
```
> smoko start ABCDEFGHIJKLMN
[2024-04-19T05:26:45.005Z] Distribution update started.
[2024-04-19T05:28:31.858Z] Distribution is deployed.
[2024-04-19T05:28:32.146Z] Cache invalidation started.
[2024-04-19T05:28:32.146Z] ABCDEFGHIJKLMN is on smoko.
```

## stop

```
Usage: smoko stop [options]

Options:
  -j, --json   output json instead of text
  -q, --quiet  silence info logs
  -h, --help   display help for command
```

*Example*
```
> smoko stop ABCDEFGHIJKLMN
[2024-04-19T05:26:00.086Z] Distribution update started.
[2024-04-19T05:26:00.367Z] Distribution is deployed.
[2024-04-19T05:26:00.367Z] ABCDEFGHIJKLMN is off smoko.
```
