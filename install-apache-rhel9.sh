[2026-01-30 11:45:17] Installing npm dependencies...
npm error code 1
npm error path /opt/PaloRuleAuditor/node_modules/esbuild
npm error command failed
npm error command sh -c node install.js
npm error node:internal/child_process:1123
npm error     result.error = new ErrnoException(result.error, 'spawnSync ' + options.file);
npm error                    ^
npm error
npm error <ref *1> Error: spawnSync /opt/PaloRuleAuditor/node_modules/esbuild/bin/esbuild EPERM
npm error     at Object.spawnSync (node:internal/child_process:1123:20)
npm error     at spawnSync (node:child_process:877:24)
npm error     at Object.execFileSync (node:child_process:920:15)
npm error     at validateBinaryVersion (/opt/PaloRuleAuditor/node_modules/esbuild/install.js:102:28)
npm error     at /opt/PaloRuleAuditor/node_modules/esbuild/install.js:287:5 {
npm error   errno: -1,
npm error   code: 'EPERM',
npm error   syscall: 'spawnSync /opt/PaloRuleAuditor/node_modules/esbuild/bin/esbuild',
npm error   path: '/opt/PaloRuleAuditor/node_modules/esbuild/bin/esbuild',
npm error   spawnargs: [ '--version' ],
npm error   error: [Circular *1],
npm error   status: null,
npm error   signal: null,
npm error   output: null,
npm error   pid: 0,
npm error   stdout: null,
npm error   stderr: null
npm error }
npm error
npm error Node.js v20.19.5
npm error A complete log of this run can be found in: /opt/PaloRuleAuditor/.npm/_logs/2026-01-30T18_45_18_150Z-debug-0.log
