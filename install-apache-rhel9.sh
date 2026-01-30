vite v6.4.1 building for production...
✓ 256 modules transformed.
dist/index.html                            0.89 kB │ gzip:   0.48 kB
dist/assets/purify.es-C_uT9hQ1.js         21.98 kB │ gzip:   8.70 kB
dist/assets/index.es-DG21eLc_.js         159.39 kB │ gzip:  53.26 kB
dist/assets/html2canvas.esm-QH1iLAAe.js  202.38 kB │ gzip:  47.71 kB
dist/assets/index-CDs3Sweh.js            220.32 kB │ gzip:  67.70 kB
dist/assets/jspdf.es.min-6THzpNb_.js     358.11 kB │ gzip: 116.79 kB
✓ built in 5.54s
[2026-01-30 14:16:24] Frontend built
[2026-01-30 14:16:24] Building backend (TypeScript to JavaScript)...

> panorama-rule-auditor@1.0.0 build:server
> tsc -p tsconfig.server.json

server/index.ts:2:8 - error TS1259: Module '"/opt/PaloRuleAuditor/node_modules/@types/express/index"' can only be default-imported using the 'allowSyntheticDefaultImports' flag

2 import express from 'express';
         ~~~~~~~

  node_modules/@types/express/index.d.ts:128:1
    128 export = e;
        ~~~~~~~~~~~
    This module is declared with 'export =', and can only be used with a default import when using the 'allowSyntheticDefaultImports' flag.

server/index.ts:3:8 - error TS1259: Module '"/opt/PaloRuleAuditor/node_modules/@types/cors/index"' can only be default-imported using the 'allowSyntheticDefaultImports' flag

3 import cors from 'cors';
         ~~~~

  node_modules/@types/cors/index.d.ts:56:1
    56 export = e;
       ~~~~~~~~~~~
    This module is declared with 'export =', and can only be used with a default import when using the 'allowSyntheticDefaultImports' flag.

server/index.ts:4:8 - error TS1259: Module '"path"' can only be default-imported using the 'allowSyntheticDefaultImports' flag

4 import path from 'path';
         ~~~~

  node_modules/@types/node/path.d.ts:187:5
    187     export = path;
            ~~~~~~~~~~~~~~
    This module is declared with 'export =', and can only be used with a default import when using the 'allowSyntheticDefaultImports' flag.

server/index.ts:7:8 - error TS1192: Module '"fs"' has no default export.

7 import fs from 'fs';
         ~~

server/panoramaService.ts:343:23 - error TS2322: Type 'string | string[]' is not assignable to type 'string | { entry?: string; }[]'.
  Type 'string[]' is not assignable to type 'string | { entry?: string; }[]'.
    Type 'string[]' is not assignable to type '{ entry?: string; }[]'.
      Type 'string' has no properties in common with type '{ entry?: string; }'.

343                       target: allConnected ? 'all' : (targets.length > 0 ? targets : undefined),
                          ~~~~~~

  server/panoramaService.ts:10:3
    10   target?: string | Array<{ entry?: string }>;
         ~~~~~~
    The expected type comes from property 'target' which is declared here on type 'PanoramaRuleUseEntry'


Found 5 errors in 2 files.

Errors  Files
     4  server/index.ts:2
     1  server/panoramaService.ts:343
[paweblog01d:121135-adm]-> 
