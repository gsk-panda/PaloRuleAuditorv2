# Technical Documentation

This document provides detailed technical information about the Palo Alto Panorama Rule Auditor application, including implementation details, data flows, and architectural decisions.

## Table of Contents

- [System Architecture](#system-architecture)
- [Component Structure](#component-structure)
- [Data Flow Diagrams](#data-flow-diagrams)
- [API Integration Details](#api-integration-details)
- [Processing Algorithms](#processing-algorithms)
  - [HA Pair Protection Algorithm](#ha-pair-protection-algorithm)
  - [Rule Filtering Algorithm](#rule-filtering-algorithm)
  - [Date Threshold Evaluation](#date-threshold-evaluation)
  - [Device Hostname Resolution](#device-hostname-resolution)
  - [Duplicate-Node Batch Rejection Handling](#duplicate-node-batch-rejection-handling)
  - [PDF Export Implementation](#pdf-export-implementation)
  - [Tag Format](#tag-format)
- [Error Handling](#error-handling)
- [Performance Characteristics](#performance-characteristics)

## System Architecture

### Technology Stack

**Frontend:**
- React 19.2.3 - UI framework
- TypeScript - Type safety
- TailwindCSS - Styling
- Vite 6.2.0 - Build tool and dev server
- jsPDF v4 - PDF generation (dynamically imported at export time; landscape orientation)

**Backend:**
- Node.js 18+ - Runtime
- Express.js 4.18.2 - Web server
- TypeScript - Type safety
- tsx 4.7.0 - TypeScript execution
- fast-xml-parser 4.3.2 - XML parsing

**External Services:**
- Palo Alto Panorama XML API - Configuration and operational data

### Application Structure

```
PaloRuleAuditor/
├── App.tsx                 # Main React component
├── components/
│   └── RuleRow.tsx         # Rule table row component
├── server/
│   ├── index.ts            # Express server and API endpoints
│   └── panoramaService.ts  # Panorama API integration logic
├── types.ts                # TypeScript type definitions
├── vite.config.ts          # Vite configuration
└── package.json           # Dependencies and scripts
```

## Component Structure

### Frontend Components

#### App.tsx (Main Application Component)

**Responsibilities:**
- User interface rendering
- Form handling and validation
- State management
- API communication
- PDF export generation

**Key Functions:**
- `handleAudit()`: Initiates audit process
- `handleApplyRemediation()`: Applies remediation actions
- `handleExportPDF()`: Generates PDF report
- `handleRuleSelection()`: Manages checkbox selection

**State Management:**
- Uses React hooks (`useState`, `useMemo`, `useRef`)
- No external state management library
- State is component-local

#### RuleRow.tsx (Rule Display Component)

**Responsibilities:**
- Display individual rule information in the audit table
- Render action badges (color-coded: red=DISABLE/DELETE, amber=UNTARGET, blue=HA-PROTECTED, purple=PROTECTED, gray=IGNORE, green=KEEP)
- Show target status with HA pair awareness — HA pairs grouped with a `↔` separator
- Display hostnames via `FirewallTarget.displayName` (falls back to serial if `displayName` is undefined)
- Show "Created" column from `PanoramaRule.createdDate`
- Handle checkbox selection (selectable only for actionable rules in current audit mode)

**Props:**
- `rule`: PanoramaRule object
- `auditMode`: 'unused' | 'disabled'
- `isSelected`: Boolean for checkbox state
- `onSelectionChange`: Callback for checkbox changes
- `rowIndex`: Number for alternating row background colors

**Table Columns (left to right):**
1. Checkbox (only rendered for selectable rules)
2. Rule Name (monospace, truncated at 220px)
3. Device Group
4. Hits (total hit count, monospace teal)
5. Last Hit (formatted date + relative age label, e.g., "Jan 19, 2026 / 1mo ago")
6. Created (formatted date + relative age from `rule.createdDate`)
7. Targets (TargetChip components; teal=has hits, red strikethrough=no hits)
8. Action badge

**TargetChip Component:**
```tsx
const TargetChip: React.FC<{ name: string; displayName?: string; hasHits: boolean }> = (
  { name, displayName, hasHits }
) => (
  <span className={`... ${hasHits ? 'teal styling' : 'red strikethrough styling'}`}>
    <span className="dot indicator" />
    {displayName || name}   {/* prefer hostname, fall back to serial */}
  </span>
);
```

### Backend Services

#### server/index.ts (Express Server)

**Endpoints:**
- `POST /api/audit`: Unused rules audit
- `POST /api/audit/disabled`: Disabled rules audit
- `POST /api/remediate`: Apply remediation actions
- `GET /health`: Health check

**Middleware:**
- CORS enabled for cross-origin requests
- JSON body parsing
- Error handling middleware

#### server/panoramaService.ts (Panorama Integration)

**Functions:**
- `fetchDeviceHostnameMap(panoramaUrl, apiKey)`: Queries `<show><devices><connected/></devices></show>` and builds a `Map<serial, hostname>`. Stores both raw (no leading zero) and 12-digit zero-padded serial forms to handle `fast-xml-parser` leading-zero stripping.
- `auditPanoramaRules(panoramaUrl, apiKey, unusedDays, haPairs)`: Main audit function for unused rules
- `auditDisabledRules(panoramaUrl, apiKey, disabledDays)`: Audit function for disabled rules - scans both pre-rulebase and post-rulebase, extracts `disabled-YYYYMMDD` tags, uses oldest tag date when multiple exist, marks rules for DELETE when tag date is older than threshold
- `extractDisabledTagDate(rule)`: Extracts the oldest `disabled-YYYYMMDD` tag from a rule's tags, returns ISO date string

**Key Operations:**
- Device hostname resolution (serial → hostname via connected-devices API)
- Device group enumeration
- Rule discovery and filtering
- Hit count querying (batch with duplicate-node retry + individual fallback)
- Timestamp extraction (`last-hit-timestamp`, `rule-creation-timestamp`)
- HA pair processing
- Per-target threshold evaluation
- Action determination

## Data Flow Diagrams

### Complete Audit Flow: Find Unused Rules

```
┌─────────────┐
│   User      │
│  Interface  │
└──────┬──────┘
       │ 1. User submits form
       │    (URL, API Key, Days, HA Pairs)
       ▼
┌─────────────────────────────────────┐
│  App.tsx: handleAudit()             │
│  - Validates input                  │
│  - Prepares request body            │
│  - POST /api/audit                  │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  server/index.ts: /api/audit        │
│  - Validates parameters             │
│  - Calls auditPanoramaRules()       │
└──────┬──────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────┐
│  panoramaService.ts                  │
│  auditPanoramaRules()                │
│                                      │
│  Step 1: Fetch Device Groups         │
│  ┌──────────────────────────────┐    │
│  │ GET /api/?type=config        │    │
│  │ XPath: .../device-group      │    │
│  └───────────┬──────────────────┘    │
│              │ Parse XML             │
│              ▼                       │
│  Step 2: Build Hostname Map          │
│  ┌──────────────────────────────┐    │
│  │ GET /api/?type=op            │    │
│  │ Cmd: <show><devices>         │    │
│  │       <connected/>           │    │
│  │ → Map<serial, hostname>      │    │
│  │   (padded + unpadded keys)   │    │
│  └───────────┬──────────────────┘    │
│              ▼                       │
│  Step 3: For Each Device Group       │
│  ┌──────────────────────────────┐    │
│  │ GET /api/?type=config        │    │
│  │ XPath: .../pre-rulebase/...  │    │
│  └───────────┬──────────────────┘    │
│              │ Parse Rules           │
│              │ Filter Disabled       │
│              │ Filter Shared         │
│              ▼                       │
│  Step 4: For Each Rule (Batch)       │
│  ┌──────────────────────────────┐    │
│  │ GET /api/?type=op            │    │
│  │ Cmd: <show><rule-hit-count>  │    │
│  │  (batch; retry on dup-node;  │    │
│  │   individual fallback)       │    │
│  └───────────┬──────────────────┘    │
│              │ Parse Hit Data        │
│              │ Aggregate device-vsys │
│              │ Extract Timestamps    │
│              │ (last-hit → creation  │
│              │  fallback; no modif.) │
│              ▼                       │
│  Step 5: Process Targets             │
│  - Resolve serial → hostname         │
│  - Map HA pairs                      │
│  - Set per-target lastHitDate        │
│  - Apply HA protection logic         │
│              ▼                       │
│  Step 6: Determine Actions           │
│  - Per-target threshold evaluation   │
│  - Apply HA pair rules               │
│  - Assign action (DISABLE/UNTARGET/  │
│    HA-PROTECTED/KEEP)                │
│  - Store earliest creationTimestamp  │
│    as rule.createdDate               │
└──────┬───────────────────────────────┘
       │
       │ Return AuditResult
       ▼
┌─────────────────────────────────────┐
│  server/index.ts                    │
│  - Format response                  │
│  - Return JSON                      │
└──────┬──────────────────────────────┘
       │
       ▼
┌───────────────────────────────────────┐
│  App.tsx: handleAudit()               │
│  - Update state (rules, deviceGroups) │
│  - Initialize selectedRuleIds         │
│  - Show report                        │
└──────┬────────────────────────────────┘
       │
       ▼
┌─────────────┐
│   UI        │
│  Display    │
└─────────────┘
```

### Remediation Flow: Disable Rules

```
┌───────────────┐
│   User        │
│  Clicks       │
│  "Apply       │
│  Remediation" │
└──────┬────────┘
       │
       ▼
┌──────────────────────────────────────┐
│  App.tsx: handleApplyRemediation()   │
│  - Validates production mode         │
│  - Filters selected rules            │
│  - Confirms action                   │
│  - POST /api/remediate               │
└──────┬───────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│  server/index.ts: /api/remediate    │
│                                     │
│  Step 1: Check/Create Tag           │
│  ┌──────────────────────────────┐   │
│  │ GET /api/?type=config        │   │
│  │ XPath: /config/shared/tag    │   │
│  └───────────┬──────────────────┘   │
│              │ Check if exists      │
│              ▼                      │
│  ┌──────────────────────────────┐   │
│  │ GET /api/?type=config        │   │
│  │ Action: set                  │   │
│  │ Create tag if missing        │   │
│  └───────────┬──────────────────┘   │
│              ▼                      │
│  Step 2: For Each Rule              │
│  ┌──────────────────────────────┐   │
│  │ GET /api/?type=config        │   │
│  │ Action: set                  │   │
│  │ Element: <disabled>yes</...> │   │
│  └───────────┬──────────────────┘   │
│              │ Disable rule         │
│              ▼                      │
│  ┌──────────────────────────────┐   │
│  │ GET /api/?type=config        │   │
│  │ Action: get                  │   │
│  │ Fetch current rule           │   │
│  └───────────┬──────────────────┘   │
│              │ Get existing tags    │
│              ▼                      │
│  ┌──────────────────────────────┐   │
│  │ GET /api/?type=config        │   │
│  │ Action: set                  │   │
│  │ Element: <tag><member>...    │   │
│  └───────────┬──────────────────┘   │
│              │ Add tag              │
│              ▼                      │
│  Step 3: Commit Changes             │
│  ┌──────────────────────────────┐   │
│  │ GET /api/?type=commit        │   │
│  │ Cmd: <commit><description>   │   │
│  └───────────┬──────────────────┘   │
│              │ Commit to Panorama   │
└──────┬──────────────────────────────┘
       │
       │ Return result
       ▼
┌─────────────────────────────────────┐
│  App.tsx                            │
│  - Display success/error message    │
│  - Update UI state                  │
└─────────────────────────────────────┘
```

## API Integration Details

### Panorama XML API Patterns

#### Request Format

All Panorama API requests follow this pattern:

```
GET {panoramaUrl}/api/?{parameters}&key={apiKey}
```

**Parameter Types:**

1. **Configuration Read:**
   ```
   type=config&action=get&xpath={encodedXPath}
   ```

2. **Configuration Set:**
   ```
   type=config&action=set&xpath={encodedXPath}&element={encodedXML}
   ```

3. **Configuration Delete:**
   ```
   type=config&action=delete&xpath={encodedXPath}
   ```

4. **Operational Query:**
   ```
   type=op&cmd={encodedXMLCommand}
   ```

5. **Commit:**
   ```
   type=commit&cmd={encodedXMLCommand}
   ```

#### XPath Encoding

All XPath values must be URL-encoded:
- Single quotes: `'` → `%27`
- Square brackets: `[` → `%5B`, `]` → `%5D`
- Spaces: ` ` → `%20` or `+`

Example:
```
/config/devices/entry[@name='localhost.localdomain']/device-group
→
/config/devices/entry%5B@name%3D%27localhost.localdomain%27%5D/device-group
```

#### XML Command Encoding

Operational commands are XML strings that must be URL-encoded:
```javascript
const xmlCmd = `<show><rule-hit-count>...</rule-hit-count></show>`;
const encoded = encodeURIComponent(xmlCmd);
```

### Response Parsing Strategy

#### Handling Variable Structures

Panorama XML responses can vary in structure. The application handles this with defensive parsing:

```typescript
// Pattern 1: Single entry
if (result.entry) {
  const entry = result.entry;
}

// Pattern 2: Multiple entries (array)
if (result.entry) {
  const entries = Array.isArray(result.entry) 
    ? result.entry 
    : [result.entry];
}

// Pattern 3: Nested structures
if (result['device-group']?.entry) {
  const deviceGroups = Array.isArray(result['device-group'].entry)
    ? result['device-group'].entry
    : [result['device-group'].entry];
}
```

#### Attribute Access

XML attributes are accessed differently based on parser configuration:

```typescript
// With attributeNamePrefix: ''
const name = entry.name || entry['@name'];

// With attributeNamePrefix: '@_'
const name = entry['@_name'] || entry.name;
```

The application uses `attributeNamePrefix: ''` for consistency.

### Hit Count Aggregation Algorithm

When processing rule-hit-count responses, the application aggregates data across multiple `device-vsys` entries. The entry name format is `{dgName}/{serial}/vsys1` — the serial is extracted and used for hostname resolution.

**Timestamp Fallback Chain**: `last-hit-timestamp` (if hit count > 0) → `rule-creation-timestamp` (never hit). `rule-modification-timestamp` is **not used** (it changes on every rule edit and is an unreliable date reference).

```typescript
// Per device-vsys entry processing
deviceVsysEntries.forEach((vsysEntry) => {
  const entryHitCount = parseInt(String(vsysEntry['hit-count'] || 0), 10);
  totalHits += entryHitCount;

  // Determine the date reference for this device-vsys entry
  const lastHitTs  = parseInt(String(vsysEntry['last-hit-timestamp']  || 0), 10);
  const creationTs = vsysEntry['rule-creation-timestamp'];  // may be number or string

  let entryTimestamp: number;
  if (entryHitCount > 0 && lastHitTs > 0) {
    entryTimestamp = lastHitTs;                              // real traffic seen
  } else if (creationTs) {
    entryTimestamp = parseInt(String(creationTs), 10);       // created but never hit
  } else {
    entryTimestamp = 0;
  }

  // Track latest last-hit across all entries (for rule.lastHitDate)
  if (entryTimestamp > latestTimestamp) {
    latestTimestamp = entryTimestamp;
  }

  // Track earliest creation timestamp (for rule.createdDate)
  if (creationTs) {
    const creationMs = parseInt(String(creationTs), 10) * 1000;
    const creationIso = new Date(creationMs).toISOString();
    if (!rule.createdDate || creationIso < rule.createdDate) {
      rule.createdDate = creationIso;
    }
  }

  // Per-target entry: extract serial from entry name for hostname lookup
  const entryName = vsysEntry['name'] || vsysEntry['@_name'] || '';
  // Format: "{dgName}/{serial}/vsys1"
  const parts = entryName.split('/');
  const targetSerial = parts.length >= 2 ? parts[1] : entryName;
  const hostname = hostnameMap.get(targetSerial)
    || hostnameMap.get(targetSerial.padStart(12, '0'));

  rule.targets.push({
    name: targetSerial,                        // serial number — used for config writes
    displayName: hostname || undefined,        // resolved hostname — display only
    hasHits: entryHitCount > 0,
    hitCount: entryHitCount,
    haPartner: haMap.get(targetSerial) || undefined,
    lastHitDate: entryTimestamp > 0
      ? new Date(entryTimestamp * 1000).toISOString()
      : new Date(0).toISOString(),
  });
});
```

## Processing Algorithms

### HA Pair Protection Algorithm

```typescript
function evaluateHAPairProtection(rule: PanoramaRule, haPairs: Map<string, string>) {
  const firewallsToUntarget = new Set<string>();
  let hasHAProtection = false;
  
  for (const target of rule.targets) {
    if (target.haPartner) {
      const partner = rule.targets.find(t => t.name === target.haPartner);
      
      if (partner) {
        // Protection Rule: If EITHER has hits, BOTH are protected
        if (target.hasHits || partner.hasHits) {
          // Don't add to untarget set (protected)
          hasHAProtection = true;
        } else {
          // Both have 0 hits, can be untargeted
          firewallsToUntarget.add(target.name);
          firewallsToUntarget.add(partner.name);
        }
      }
    } else {
      // Non-HA target: evaluate individually
      if (!target.hasHits && isUnused(target)) {
        firewallsToUntarget.add(target.name);
      }
    }
  }
  
  // Determine final action
  if (hasHAProtection && firewallsToUntarget.size === 0) {
    return 'HA-PROTECTED';
  } else if (firewallsToUntarget.size === rule.targets.length) {
    return 'DISABLE';
  } else if (firewallsToUntarget.size > 0) {
    return 'UNTARGET';
  } else {
    return 'KEEP';
  }
}
```

### Rule Filtering Algorithm

```typescript
function filterRules(rules: any[], sharedRuleNames: Set<string>) {
  return rules.filter((rule) => {
    // Skip disabled rules
    if (rule.disabled === 'yes') {
      return false;
    }
    
    // Skip rules with same name as Shared rules
    const ruleName = rule.name || rule['@name'];
    if (sharedRuleNames.has(ruleName)) {
      return false;
    }
    
    return true;
  });
}
```

### Disabled Rules Tag Extraction Algorithm

The disabled rules audit uses `disabled-YYYYMMDD` tags to determine when a rule was disabled. When multiple such tags exist on a rule, the **oldest** date is used.

```typescript
function extractDisabledTagDate(rule: any): string | undefined {
  const ruleName = rule.name || rule['@_name'];
  
  // Extract all tags from the rule
  const members = rule.tag?.member
    ? (Array.isArray(rule.tag.member) ? rule.tag.member : [rule.tag.member])
    : [];
  
  let oldestDate: Date | undefined;
  let oldestDateStr: string | undefined;
  
  // Find all disabled-YYYYMMDD tags
  for (const m of members) {
    const val = String(typeof m === 'string' ? m : (m._text ?? m));
    const match = val.match(/^disabled-(\d{4})(\d{2})(\d{2})$/i);
    
    if (match) {
      // Parse date: disabled-20250822 → 2025-08-22
      const dateStr = `${match[1]}-${match[2]}-${match[3]}T00:00:00Z`;
      const date = new Date(dateStr);
      
      // Keep track of the oldest date
      if (!oldestDate || date < oldestDate) {
        oldestDate = date;
        oldestDateStr = date.toISOString();
      }
    }
  }
  
  return oldestDateStr;
}
```

**Key Features:**
- Scans both pre-rulebase and post-rulebase rules
- Handles multiple `disabled-YYYYMMDD` tags by selecting the oldest
- Case-insensitive tag matching (`disabled-` or `DISABLED-`)
- Returns ISO date string for threshold comparison
- Rules without `disabled-YYYYMMDD` tags are excluded from results

**Action Assignment:**
```typescript
const disabledThreshold = new Date(Date.now() - disabledDays * 86_400_000);
const disabledTagDate = new Date(disabledTagDateStr);

if (protectedRuleSet.has(`${dgName}:${ruleName}`)) {
  action = 'PROTECTED';  // Rule has PROTECT tag
} else if (disabledTagDate < disabledThreshold) {
  action = 'DELETE';     // Tag date older than threshold
} else {
  // Tag date within threshold - not included in results
}
```

### Date Threshold Evaluation

Threshold evaluation is performed **per target** (per `FirewallTarget`), not at the rule level. This prevents a rule from being permanently marked KEEP just because it has any non-zero total hits — it correctly identifies which specific devices have gone unused.

```typescript
const unusedThreshold = new Date(Date.now() - unusedDays * 86_400_000);

for (const target of rule.targets) {
  const targetLastHit = target.lastHitDate
    ? new Date(target.lastHitDate)
    : new Date(0);                          // treat missing as epoch (always unused)

  // A target is unused if its last-hit date is before the threshold
  const isUnused = targetLastHit < unusedThreshold;

  if (isUnused) {
    // Potentially add this target to the untarget/disable set
    // (subject to HA pair protection logic — see HA Pair Protection Algorithm)
    firewallsToUntarget.add(target.name);
  }
}
```

**Key differences from rule-level evaluation:**
- A rule with 10,000 total hits on fw1 but 0 hits on fw2 since the threshold → fw2 is added to `firewallsToUntarget`
- If fw1 and fw2 are an HA pair and fw1 has recent hits → both are protected (HA-PROTECTED)
- If fw1 and fw2 are independent targets → fw2 is untargeted while fw1 is kept (UNTARGET)

### Device Hostname Resolution

Panorama's `show rule-hit-count` API returns device-vsys entries named `{dgName}/{serial}/vsys1`. The serial (e.g., `011901012320`) must be resolved to a human-readable hostname (e.g., `midtown-place-fw1`) for display purposes.

**Resolution Flow:**
```typescript
async function fetchDeviceHostnameMap(
  panoramaUrl: string,
  apiKey: string
): Promise<Map<string, string>> {
  const hostnameMap = new Map<string, string>();

  // Query connected devices
  const cmd = '<show><devices><connected/></devices></show>';
  const response = await fetch(`${panoramaUrl}/api/?type=op&cmd=${encodeURIComponent(cmd)}&key=${apiKey}`);
  const xml = await response.text();
  const parsed = new XMLParser({ ignoreAttributes: false, ... }).parse(xml);

  const entries = /* normalize to array */;

  entries.forEach((entry: any) => {
    const serial: string = String(entry.serial || entry['@_name'] || entry.name || '');
    const hostname: string = String(entry.hostname || '');

    if (serial && hostname) {
      // Store both forms to handle fast-xml-parser leading-zero stripping:
      // fast-xml-parser parses "011901012320" as integer 11901012320,
      // dropping the leading zero. Storing both ensures lookups succeed.
      hostnameMap.set(serial, hostname);                    // unpadded: "11901012320"
      hostnameMap.set(serial.padStart(12, '0'), hostname);  // padded:   "011901012320"
    }
  });

  return hostnameMap;
}
```

**Why Both Padded and Unpadded?**
`fast-xml-parser` with `parseAttributeValue: true` converts numeric-looking strings to JavaScript numbers. The serial `"011901012320"` (12 digits, leading zero) becomes integer `11901012320`. When this number is later converted back to a string (via `String()`), the leading zero is gone. Since hit-count responses may use either form depending on parsing context, both keys are stored so the `Map.get()` lookup succeeds.

**Usage in FirewallTarget:**
```typescript
// name = serial number (for Panorama write operations: <entry name="011901012320"/>)
// displayName = resolved hostname (for display only)
target.displayName = hostnameMap.get(targetSerial)
  || hostnameMap.get(targetSerial.padStart(12, '0'))
  || undefined;  // undefined if device not in connected list
```

### Duplicate-Node Batch Rejection Handling

Panorama's `show rule-hit-count` API can reject batch requests containing multiple `<entry>` elements in `<rule-name>` with an error like:

```
<response status="error"><msg>"Midtown - Proxy" is a duplicate node</msg></response>
```

**Important**: This error is misleading. It does **not** mean the rule name is duplicated in the Panorama configuration. It is a Panorama API limitation where certain device groups reject batched `<rule-name>` queries. Rules queried individually always succeed.

**Retry Loop Algorithm:**
```typescript
const skippedDuplicates = new Set<string>();
let chunk = [...ruleNames];                    // start with all rules in the batch
const maxAttempts = chunk.length;              // capture BEFORE chunk shrinks

for (let attempt = 0; attempt <= maxAttempts; attempt++) {
  if (chunk.length === 0) break;

  const response = await queryBatch(chunk);

  if (response.status === 'error') {
    // Extract the offending rule name from the error message
    const match = response.message.match(/"(.+)" is a duplicate node/);
    if (match) {
      const offender = match[1];
      skippedDuplicates.add(offender);
      chunk = chunk.filter(r => r !== offender);  // remove from batch, retry
      continue;
    }
    break;  // different error — stop retrying
  }

  // Success — process results
  processResults(response);
  break;
}

// Individual fallback for all duplicate-rejected rules
for (const ruleName of skippedDuplicates) {
  const singleResponse = await queryIndividual(ruleName);
  processResults(singleResponse);
}
```

**Why `maxAttempts` Must Be Captured Before the Loop:**
The original bug was `for (let attempt = 0; attempt <= chunk.length; attempt++)`. As rules are removed from `chunk`, `chunk.length` decreases, causing the loop to exit prematurely before processing all rules. Capturing `const maxAttempts = chunk.length` before the loop fixes this — the loop bound is fixed regardless of how many rules are removed.

**`<all/>` Behavior (Rejected Alternative):**
During investigation, `<all/>` was tested as an alternative to `<entry>` batching. `<all/>` returns `rule-state` (Used/Unused/Partial) but does **not** return `hit-count` or `last-hit-timestamp` — making it completely unusable for date-based threshold evaluation.

### PDF Export Implementation

```typescript
async function handleExportPDF() {
  const { jsPDF } = await import('jspdf');  // dynamic import (v4)

  const doc = new jsPDF({ orientation: 'landscape' });  // A4 landscape

  // Column definitions
  const cols = ['Rule Name', 'Device Group', 'Hits', 'Last Hit', 'Created', 'Targets', 'Action'];
  const widths = [60, 35, 16, 28, 28, 60, 22];  // mm widths

  // Per-row data construction
  rules.forEach(rule => {
    const cd = rule.createdDate
      ? new Date(rule.createdDate).toLocaleDateString()
      : '—';
    const tgts = rule.targets
      .map(t => t.displayName || t.name)  // prefer hostname, fall back to serial
      .join(', ');
    // ... render row
  });

  doc.save(`panorama-audit-${new Date().toISOString().slice(0, 10)}.pdf`);
}
```

### Tag Format

When disabling unused rules in production mode, a date-based tag is applied:

```
Format: disabled-YYYYMMDD
Example: disabled-20260222
```

**Generation:**
```typescript
function getDisabledTag(): string {
  const d = new Date();
  return `disabled-${d.getFullYear()}${
    String(d.getMonth() + 1).padStart(2, '0')}${
    String(d.getDate()).padStart(2, '0')}`;
}
```

No time component is included — this ensures rules disabled on the same calendar day all receive the same tag, making batch identification easy.

## Error Handling

### Error Types

1. **Network Errors**
   - Connection timeouts
   - DNS resolution failures
   - SSL/TLS errors
   - **Handling**: Caught in try-catch, logged, returned to user

2. **API Errors**
   - 401 Unauthorized (invalid API key)
   - 403 Forbidden (insufficient permissions)
   - 404 Not Found (invalid XPath)
   - 500 Server Error (Panorama internal error)
   - **Handling**: Parsed from XML response, logged, returned to user

3. **Data Errors**
   - Missing required fields
   - Invalid XML structure
   - Type mismatches
   - **Handling**: Defensive parsing, null checks, default values

4. **Business Logic Errors**
   - No rules found
   - No device groups found
   - Invalid HA pair format
   - **Handling**: Validation, user-friendly error messages

### Error Propagation

```
Panorama API Error
    ↓
panoramaService.ts (try-catch)
    ↓
server/index.ts (error handler)
    ↓
HTTP 500 Response with error message
    ↓
App.tsx (fetch error handling)
    ↓
User Alert/Notification
```

## Performance Characteristics

### Time Complexity

- **Device Group Discovery**: O(1) - Single API call
- **Rule Discovery**: O(DG × R) where DG = device groups, R = rules per group
- **Hit Count Queries**: O(R) - One query per rule
- **HA Pair Processing**: O(R × T) where T = targets per rule
- **Overall**: O(DG × R + R × T) ≈ O(R × T) for typical deployments

### Space Complexity

- **Rule Storage**: O(R) - All rules stored in memory
- **Device Groups**: O(DG) - Device group names
- **HA Pairs**: O(HP) where HP = number of HA pairs
- **Overall**: O(R + DG + HP)

### API Call Count

For a typical audit:
- Hostname map: **1 call** (`<show><devices><connected/>`)
- Device groups: paginated (1+ calls depending on total-count)
- Rules per device group: paginated (1+ calls per device group)
- Hit counts: **variable** — starts as batched requests; degrades to individual calls for device groups that reject batching with "duplicate node" errors
  - Best case (no duplicates): O(DG) calls for hit counts (one batch per device group)
  - Worst case (all rules rejected): O(R) calls (one per rule)
  - Typical case: mixed — some device groups batch successfully, others fall back to individual
- **Total**: O(1 + device-group pages + rule pages per DG + DG-to-R) where R = rules with duplicate-node issues

Example: 5 device groups, 100 rules (2 device groups have duplicate-node issues, 60 of the 100 rules)
- Hostname map: 1 call; device groups: ~1 call; rules config: ~5 calls; hit counts: ~40 batched + ~60 individual = ~42 hit-count calls
- **Total**: ~50 API calls

### Estimated Processing Time

**Current implementation (one rule per hit-count call, paginated config):**
- **Small deployment** (1-2 device groups, <50 rules): 30–90 seconds
- **Medium deployment** (3-5 device groups, 50-200 rules): 2–8 minutes
- **Large deployment** (10+ device groups, 200+ rules): 5–20+ minutes

Times vary based on:
- Panorama response latency
- Network conditions
- API rate limiting
- Total number of rules (primary factor for hit-count calls)

## Security Considerations

### API Key Handling

- API keys are never logged in production
- Keys are passed in URL parameters (HTTPS required)
- Keys are not stored in browser localStorage
- Keys are cleared on page refresh

### Data Transmission

- All Panorama communication over HTTPS
- API keys in URL parameters (standard Panorama API pattern)
- No sensitive data in response bodies
- Error messages sanitized before display

### Input Validation

- URL validation (must be HTTPS)
- API key format validation
- Numeric threshold validation
- HA pair file format validation
- XPath injection prevention (hardcoded XPath patterns)

## Future Enhancements

### Potential Improvements

1. **Caching Layer**
   - Cache device group lists
   - Cache rule configurations
   - Cache hit count data (with TTL)

2. **Progress Tracking**
   - Real-time progress updates
   - Estimated time remaining
   - Cancel operation capability

3. **Export Formats**
   - CSV export
   - JSON export
   - Excel export

4. **Scheduled Audits**
   - Cron-based scheduling
   - Email notifications
   - Automated reporting

5. **Multi-Panorama Support**
   - Manage multiple Panorama instances
   - Compare results across instances
   - Centralized reporting
