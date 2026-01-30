Jan 30 14:09:28 paweblog01d systemd[1]: panoruleauditor-backend.service: Scheduled restart job, restart counter is at 3.
Jan 30 14:09:28 paweblog01d systemd[1]: Stopped PaloRuleAuditor Backend API.
Jan 30 14:09:28 paweblog01d systemd[1]: Started PaloRuleAuditor Backend API.
Jan 30 14:09:28 paweblog01d node[838349]: node:internal/fs/promises:639
Jan 30 14:09:28 paweblog01d node[838349]:   return new FileHandle(await PromisePrototypeThen(
Jan 30 14:09:28 paweblog01d node[838349]:                         ^
Jan 30 14:09:28 paweblog01d node[838349]: Error: EPERM: operation not permitted, open '/opt/PaloRuleAuditor/node_modules/tsx/dist/loader.mjs'
Jan 30 14:09:28 paweblog01d node[838349]:     at async open (node:internal/fs/promises:639:25)
Jan 30 14:09:28 paweblog01d node[838349]:     at async readFile (node:internal/fs/promises:1246:14)
Jan 30 14:09:28 paweblog01d node[838349]:     at async getSource (node:internal/modules/esm/load:48:14)
Jan 30 14:09:28 paweblog01d node[838349]:     at async defaultLoad (node:internal/modules/esm/load:139:34)
Jan 30 14:09:28 paweblog01d node[838349]:     at async ModuleLoader.loadAndTranslate (node:internal/modules/esm/loader:543:45)
Jan 30 14:09:28 paweblog01d node[838349]:     at async ModuleJob._link (node:internal/modules/esm/module_job:148:19) {
Jan 30 14:09:28 paweblog01d node[838349]:   errno: -1,
Jan 30 14:09:28 paweblog01d node[838349]:   code: 'EPERM',
Jan 30 14:09:28 paweblog01d node[838349]:   syscall: 'open',
Jan 30 14:09:28 paweblog01d node[838349]:   path: '/opt/PaloRuleAuditor/node_modules/tsx/dist/loader.mjs'
Jan 30 14:09:28 paweblog01d node[838349]: }
Jan 30 14:09:28 paweblog01d node[838349]: Node.js v20.19.5
Jan 30 14:09:29 paweblog01d systemd[1]: panoruleauditor-backend.service: Main process exited, code=exited, status=1/FAILURE
Jan 30 14:09:29 paweblog01d systemd[1]: panoruleauditor-backend.service: Failed with result 'exit-code'.
