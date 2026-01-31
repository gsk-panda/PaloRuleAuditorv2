# Technical Documentation

This document provides detailed technical information about the Palo Alto Panorama Rule Auditor application, including implementation details, data flows, and architectural decisions.

## Table of Contents

- [System Architecture](#system-architecture)
- [Component Structure](#component-structure)
- [Data Flow Diagrams](#data-flow-diagrams)
- [API Integration Details](#api-integration-details)
- [Processing Algorithms](#processing-algorithms)
- [Error Handling](#error-handling)
- [Performance Characteristics](#performance-characteristics)

## System Architecture

### Technology Stack

**Frontend:**
- React 19.2.3 - UI framework
- TypeScript - Type safety
- TailwindCSS - Styling
- Vite 6.2.0 - Build tool and dev server
- jsPDF 2.5.2 - PDF generation

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
- Display individual rule information
- Render action badges
- Show target status with HA pair awareness
- Handle checkbox selection (disabled rules mode)

**Props:**
- `rule`: PanoramaRule object
- `auditMode`: 'unused' | 'disabled'
- `isSelected`: Boolean for checkbox state
- `onSelectionChange`: Callback for checkbox changes

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
- `auditPanoramaRules()`: Main audit function for unused rules
- `auditDisabledRules()`: Audit function for disabled rules

**Key Operations:**
- Device group enumeration
- Rule discovery and filtering
- Hit count aggregation
- HA pair processing
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
│  Step 2: For Each Device Group       │
│  ┌──────────────────────────────┐    │
│  │ GET /api/?type=config        │    │
│  │ XPath: .../pre-rulebase/...  │    │
│  └───────────┬──────────────────┘    │
│              │ Parse Rules           │
│              │ Filter Disabled       │
│              │ Filter Shared         │
│              ▼                       │
│  Step 3: For Each Rule               │
│  ┌──────────────────────────────┐    │
│  │ GET /api/?type=op            │    │
│  │ Cmd: <show><rule-hit-count>  │    │
│  └───────────┬──────────────────┘    │
│              │ Parse Hit Data        │
│              │ Aggregate device-vsys │
│              │ Extract Timestamps    │
│              ▼                       │
│  Step 4: Process Targets             │
│  - Map HA pairs                      │
│  - Determine hit status              │
│  - Apply HA protection logic         │
│              ▼                       │
│  Step 5: Determine Actions           │
│  - Evaluate unused threshold         │
│  - Apply HA pair rules               │
│  - Assign action (DISABLE/UNTARGET/  │
│    HA-PROTECTED/KEEP)                │
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

When processing rule-hit-count responses, the application aggregates data across multiple `device-vsys` entries:

```typescript
let totalHits = 0;
let lastHitTimestamp = '0';
let modificationTimestamp = '0';

// Process each device-vsys entry
deviceVsysEntries.forEach((vsysEntry) => {
  // Aggregate hit counts
  const hitCount = parseInt(vsysEntry['hit-count'] || '0', 10);
  totalHits += hitCount;
  
  // Find latest last-hit-timestamp
  const lastHit = vsysEntry['last-hit-timestamp'] || '0';
  if (parseInt(lastHit) > parseInt(lastHitTimestamp)) {
    lastHitTimestamp = lastHit;
  }
  
  // Find latest modification timestamp
  const modTs = vsysEntry['rule-modification-timestamp'] || '0';
  if (parseInt(modTs) > parseInt(modificationTimestamp)) {
    modificationTimestamp = modTs;
  }
});

// Use modification timestamp if last-hit is 0
const finalTimestamp = lastHitTimestamp === '0' 
  ? modificationTimestamp 
  : lastHitTimestamp;
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

### Date Threshold Evaluation

```typescript
function isRuleUnused(rule: PanoramaRule, thresholdDays: number): boolean {
  const thresholdDate = new Date();
  thresholdDate.setDate(thresholdDate.getDate() - thresholdDays);
  
  const lastHitDate = new Date(rule.lastHitDate);
  
  // Rule is unused if:
  // 1. Has 0 total hits, OR
  // 2. Last hit was before threshold date
  return rule.totalHits === 0 || lastHitDate < thresholdDate;
}
```

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
- Device groups: paginated (1+ calls depending on total-count)
- Rules per device group: paginated (1+ calls per device group)
- Hit counts: **one API call per rule** (chunk size 1) to avoid 414 Request-URI Too Long and duplicate-node errors
- **Total**: O(device-group pages + rule pages per DG + R) where R = total rules

Example: 5 device groups, 100 rules
- Device groups: 1–2 calls; rules config: ~5–10 calls; hit counts: 100 calls
- **Total**: on the order of 100+ API calls

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
