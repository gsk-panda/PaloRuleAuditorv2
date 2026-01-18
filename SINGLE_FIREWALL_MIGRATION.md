# Single Firewall Migration Guide

This document outlines the changes needed to adapt PaloRuleAuditor to work with a single firewall instead of Panorama.

## Key Architectural Differences

### Panorama Structure
- **Device Groups**: Rules are organized in device groups
- **Pre-rulebase**: Rules applied before device-specific rules
- **Device Name**: Always `localhost.localdomain`
- **XPath Pattern**: `/config/devices/entry[@name='localhost.localdomain']/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules`

### Single Firewall Structure
- **VSYS**: Rules are organized in virtual systems (typically `vsys1`)
- **Rulebase**: Direct rulebase (no pre/post distinction)
- **Device Name**: The actual firewall hostname/IP
- **XPath Pattern**: `/config/devices/entry[@name='${firewallName}']/vsys/entry[@name='vsys1']/rulebase/security/rules`

## Required Changes

### 1. Configuration Changes

#### `types.ts`
- Add `firewallMode: 'panorama' | 'firewall'` to `PanoramaConfig`
- Add `firewallName?: string` for single firewall mode
- Add `vsysName?: string` (default: `vsys1`)
- Change `deviceGroup` in `PanoramaRule` to `vsys?: string` (make it optional)

#### `App.tsx`
- Add UI toggle/selection for Panorama vs Single Firewall mode
- Add input field for firewall name (when in firewall mode)
- Add input field for VSYS name (default: `vsys1`)
- Remove device group display (or show VSYS instead)
- Update form validation

### 2. API Path Changes

#### `server/panoramaService.ts`

**For fetching rules:**
```typescript
// Panorama (current):
const url = `${panoramaUrl}/api/?type=config&action=get&xpath=/config/devices/entry[@name='localhost.localdomain']/device-group/entry[@name='${dgName}']/pre-rulebase/security/rules&key=${apiKey}`;

// Single Firewall (new):
const url = `${firewallUrl}/api/?type=config&action=get&xpath=/config/devices/entry[@name='${firewallName}']/vsys/entry[@name='${vsysName}']/rulebase/security/rules&key=${apiKey}`;
```

**For rule hit count queries:**
```typescript
// Panorama (current):
const xmlCmd = `<show><rule-hit-count><device-group><entry name="${dgName}"><pre-rulebase><entry name="security"><rules><rule-name><entry name="${ruleName}"/></rule-name></rules></entry></pre-rulebase></entry></device-group></rule-hit-count></show>`;

// Single Firewall (new):
const xmlCmd = `<show><rule-hit-count><vsys><entry name="${vsysName}"><rulebase><entry name="security"><rules><rule-name><entry name="${ruleName}"/></rule-name></rules></entry></rulebase></entry></vsys></rule-hit-count></show>`;
```

**For remediation (disable/delete):**
```typescript
// Panorama (current):
const xpath = `/config/devices/entry[@name='localhost.localdomain']/device-group/entry[@name='${rule.deviceGroup}']/pre-rulebase/security/rules/entry[@name='${rule.name}']`;

// Single Firewall (new):
const xpath = `/config/devices/entry[@name='${firewallName}']/vsys/entry[@name='${vsysName}']/rulebase/security/rules/entry[@name='${rule.name}']`;
```

### 3. Service Layer Changes

#### `server/panoramaService.ts`

**Create new function or refactor existing:**

```typescript
export async function auditFirewallRules(
  firewallUrl: string,
  apiKey: string,
  firewallName: string,
  vsysName: string,
  unusedDays: number,
  haPairs: HAPair[]
): Promise<AuditResult> {
  // Similar structure to auditPanoramaRules but:
  // 1. Skip device group fetching - go directly to vsys
  // 2. Use vsys-based XPath patterns
  // 3. Use vsys-based hit count queries
  // 4. No "Shared" device group concept
}
```

**Key differences:**
- No device group enumeration loop
- Direct vsys access
- Different XML structure for hit count responses
- Response parsing will be different (no `device-group` wrapper)

### 4. Response Parsing Changes

**Hit count response structure:**

**Panorama:**
```xml
<response>
  <result>
    <rule-hit-count>
      <device-group>
        <entry name="dgName">
          <pre-rulebase>
            <entry name="security">
              <rules>
                <entry name="ruleName">
                  <device-vsys>
                    <entry name="fw/vsys">
                      <hit-count>123</hit-count>
                      <last-hit-timestamp>1234567890</last-hit-timestamp>
                    </entry>
                  </device-vsys>
                </entry>
              </rules>
            </entry>
          </pre-rulebase>
        </entry>
      </device-group>
    </rule-hit-count>
  </result>
</response>
```

**Single Firewall:**
```xml
<response>
  <result>
    <rule-hit-count>
      <vsys>
        <entry name="vsys1">
          <rulebase>
            <entry name="security">
              <rules>
                <entry name="ruleName">
                  <hit-count>123</hit-count>
                  <last-hit-timestamp>1234567890</last-hit-timestamp>
                </entry>
              </rules>
            </entry>
          </rulebase>
        </entry>
      </vsys>
    </rule-hit-count>
  </result>
</response>
```

### 5. Backend Endpoint Changes

#### `server/index.ts`

**Update `/api/audit` endpoint:**
```typescript
app.post('/api/audit', async (req, res) => {
  const { url, apiKey, unusedDays, haPairs, firewallMode, firewallName, vsysName } = req.body;
  
  if (firewallMode === 'firewall') {
    // Call auditFirewallRules
    const result = await auditFirewallRules(url, apiKey, firewallName, vsysName || 'vsys1', unusedDays, haPairs);
  } else {
    // Call auditPanoramaRules (existing)
    const result = await auditPanoramaRules(url, apiKey, unusedDays, haPairs);
  }
});
```

**Update `/api/remediate` endpoint:**
- Use firewall-based XPath when `firewallMode === 'firewall'`
- Pass `firewallName` and `vsysName` from request body

### 6. UI Changes

#### `App.tsx`

**Add mode selection:**
```tsx
const [firewallMode, setFirewallMode] = useState<'panorama' | 'firewall'>('panorama');
const [firewallName, setFirewallName] = useState('');
const [vsysName, setVsysName] = useState('vsys1');
```

**Conditional form fields:**
- Show device group fields only in Panorama mode
- Show firewall name and VSYS fields only in firewall mode
- Update labels: "Device Groups" → "VSYS" when in firewall mode

**Update rule display:**
- Change "Device Group" column to "VSYS" in firewall mode
- Remove "Shared" device group filtering logic

### 7. Removed Features for Single Firewall

- **Device Groups**: No device group enumeration
- **Shared Device Group**: Single firewalls don't have this concept
- **Pre-rulebase vs Post-rulebase**: Single firewalls use direct rulebase
- **Device Group filtering**: Replace with VSYS filtering if needed

### 8. Implementation Strategy

**Option A: Dual Mode (Recommended)**
- Keep both Panorama and Firewall functions
- Add mode selector in UI
- Route to appropriate function based on mode
- Maintain backward compatibility

**Option B: Separate Application**
- Create new `firewallService.ts` file
- Duplicate and modify existing functions
- Simpler but more code duplication

**Option C: Unified Service**
- Refactor to single function with mode parameter
- More complex but single codebase

## Example Code Snippets

### Fetching VSYS Rules
```typescript
const vsysRulesUrl = `${firewallUrl}/api/?type=config&action=get&xpath=/config/devices/entry[@name='${firewallName}']/vsys/entry[@name='${vsysName}']/rulebase/security/rules&key=${apiKey}`;
const response = await fetch(vsysRulesUrl);
const xmlText = await response.text();
const data = parser.parse(xmlText);

let rules: any[] = [];
if (data.response?.result?.rules?.entry) {
  rules = Array.isArray(data.response.result.rules.entry)
    ? data.response.result.rules.entry
    : [data.response.result.rules.entry];
}
```

### Querying Hit Counts
```typescript
const rulebaseXml = `<rulebase><entry name="security"><rules><rule-name><entry name="${ruleName}"/></rule-name></rules></entry></rulebase>`;
const xmlCmd = `<show><rule-hit-count><vsys><entry name="${vsysName}">${rulebaseXml}</entry></vsys></rule-hit-count></show>`;
const apiUrl = `${firewallUrl}/api/?type=op&cmd=${encodeURIComponent(xmlCmd)}&key=${apiKey}`;
```

### Disabling/Deleting Rules
```typescript
const xpath = `/config/devices/entry[@name='${firewallName}']/vsys/entry[@name='${vsysName}']/rulebase/security/rules/entry[@name='${rule.name}']`;
const disableUrl = `${firewallUrl}/api/?type=config&action=set&xpath=${encodeURIComponent(xpath)}&element=${encodeURIComponent('<disabled>yes</disabled>')}&key=${apiKey}`;
```

## Testing Checklist

- [ ] Fetch rules from single firewall VSYS
- [ ] Query hit counts correctly
- [ ] Parse hit count responses (no device-group wrapper)
- [ ] Disable rules in firewall mode
- [ ] Delete rules in firewall mode
- [ ] Commit changes to firewall
- [ ] Handle multiple VSYS if needed
- [ ] UI correctly shows VSYS instead of device groups
- [ ] HA pairs still work correctly
- [ ] Error handling for invalid firewall name/VSYS

## Notes

- Single firewalls typically have only one VSYS (`vsys1`), but some may have multiple
- Consider adding VSYS enumeration if multiple VSYS support is needed
- Tag management path changes: `/config/shared/tag` may still work, but verify
- Commit behavior should be the same for both modes
