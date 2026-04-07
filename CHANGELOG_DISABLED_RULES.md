# Disabled Rules Logic Update - April 6, 2026

## Summary

Updated the disabled rules audit to use `disabled-YYYYMMDD` tags for date tracking instead of relying on `rule-modification-timestamp`. This provides more accurate tracking of when rules were actually disabled and allows for proper identification of rules that should be deleted.

## Changes Made

### Backend Changes

#### 1. Tag Extraction Logic (`server/panoramaService.ts`)

**Function: `extractDisabledTagDate()`**
- Extracts `disabled-YYYYMMDD` tags from rule configurations
- Handles multiple disabled tags by selecting the **oldest** date
- Case-insensitive matching (`disabled-` or `DISABLED-`)
- Returns ISO date string for threshold comparison

**Key Features:**
```typescript
// Example: Rule has tags: ["disabled-20250822", "disabled-20260101"]
// Function returns: "2025-08-22T00:00:00.000Z" (oldest date)
```

#### 2. Rulebase Scanning (`server/panoramaService.ts`)

**Extended to scan both pre-rulebase and post-rulebase:**
- Previously only scanned pre-rulebase rules
- Now scans both `/pre-rulebase/security/rules` and `/post-rulebase/security/rules`
- Ensures all disabled rules are discovered regardless of rulebase location

#### 3. Action Assignment Logic (`server/panoramaService.ts`)

**Updated action determination:**
- Rules with `disabled-YYYYMMDD` tags **older than threshold** → `action = "DELETE"`
- Rules with `PROTECT` tag → `action = "PROTECTED"` (excluded from deletion)
- Rules with `disabled-YYYYMMDD` tags **within threshold** → not included in results
- Rules **without** `disabled-YYYYMMDD` tags → not included in results

**Previous behavior:**
- Used `rule-modification-timestamp` which was unreliable (changes on any rule edit)
- All disabled rules marked with `action = "DISABLE"`

**New behavior:**
- Uses explicit `disabled-YYYYMMDD` tags for accurate date tracking
- Rules marked with `action = "DELETE"` for clarity

#### 4. Code Structure Fixes (`server/panoramaService.ts`)

- Fixed indentation issues in rule processing loop
- Ensured rules are properly added to `disabledRules` array
- Added detailed logging for debugging

### Frontend Changes

#### 1. Badge Configuration (`components/RuleRow.tsx`)

**Added DELETE badge:**
```typescript
DELETE: { 
  dot: 'bg-red-500', 
  text: 'text-red-400', 
  bg: 'bg-red-500/10', 
  border: 'border-red-500/30', 
  label: 'Delete' 
}
```

**Previous behavior:**
- Missing DELETE badge caused all DELETE actions to display as "Keep" (fallback)

**New behavior:**
- DELETE actions display with red badge labeled "Delete"

### Documentation Updates

#### 1. README.md

**Updated sections:**
- "Complete Data Flow: Find Disabled Rules" - Added tag extraction details
- "Disabled Rule Discovery" - Documented pre/post-rulebase scanning
- "Date Evaluation" - Explained tag-based date comparison
- "Action Assignment" - Clarified DELETE vs PROTECTED actions
- "Remediation" - Updated deletion logic documentation

#### 2. TECHNICAL_DOCUMENTATION.md

**Added sections:**
- "Disabled Rules Tag Extraction Algorithm" - Complete algorithm documentation
- Updated function descriptions for `auditDisabledRules()` and `extractDisabledTagDate()`
- Updated RuleRow component documentation to include DELETE badge

## Behavior Changes

### Before

1. **Date Source**: Used `rule-modification-timestamp` from API
   - Problem: Changes whenever rule is edited, not just when disabled
   - Result: Inaccurate tracking of when rule was actually disabled

2. **Rulebase Coverage**: Only scanned pre-rulebase
   - Problem: Missed disabled rules in post-rulebase
   - Result: Incomplete audit results

3. **Action Display**: All disabled rules showed "Keep" in UI
   - Problem: Missing DELETE badge configuration
   - Result: Confusing user experience

### After

1. **Date Source**: Uses `disabled-YYYYMMDD` tags
   - Accurate tracking of when rule was disabled
   - Handles multiple tags by using oldest date
   - Rules without tags are excluded (not ready for deletion)

2. **Rulebase Coverage**: Scans both pre-rulebase and post-rulebase
   - Complete discovery of all disabled rules
   - Accurate audit results

3. **Action Display**: Rules show "Delete" badge in red
   - Clear indication of rules marked for deletion
   - Consistent with backend action assignment

## Usage

### Tagging Disabled Rules

When disabling a rule, add a `disabled-YYYYMMDD` tag:

```
Tag format: disabled-20260406
           disabled-YYYYMMDD
           
Example: disabled-20250822 = August 22, 2025
```

### Multiple Tags

If a rule has multiple `disabled-YYYYMMDD` tags, the **oldest** date is used:

```
Rule tags: ["disabled-20250822", "disabled-20260101", "other-tag"]
Date used: August 22, 2025 (oldest)
```

### Protected Rules

Rules with a `PROTECT` tag are excluded from deletion:

```
Rule tags: ["disabled-20250822", "PROTECT"]
Action: PROTECTED (not DELETE)
```

### Audit Results

Only rules with `disabled-YYYYMMDD` tags **older than the threshold** appear in results:

```
Threshold: 90 days (default)
Today: April 6, 2026
Threshold date: January 6, 2026

Rule with disabled-20250822 (Aug 22, 2025): Included (228 days old) → DELETE
Rule with disabled-20260201 (Feb 1, 2026): Not included (64 days old)
Rule with no disabled tag: Not included
```

## Testing

Verified with production data:
- 8 rules with `disabled-YYYYMMDD` tags older than 90 days correctly identified
- All 8 rules marked with DELETE action
- Rules displayed with red "Delete" badge in UI
- Rules without `disabled-YYYYMMDD` tags excluded from results
- Rules with PROTECT tag marked as PROTECTED

## Migration Notes

**No migration required** - the application now looks for `disabled-YYYYMMDD` tags on existing disabled rules. 

**Recommendation**: Add `disabled-YYYYMMDD` tags to existing disabled rules to enable proper tracking:
1. Identify disabled rules without tags
2. Add appropriate `disabled-YYYYMMDD` tag based on when rule was disabled
3. Run audit to verify rules appear in results

## Files Modified

1. `server/panoramaService.ts`
   - Added `extractDisabledTagDate()` function
   - Updated `auditDisabledRules()` to scan both rulebases
   - Updated action assignment logic
   - Fixed code structure and indentation

2. `components/RuleRow.tsx`
   - Added DELETE badge configuration

3. `server/index.ts`
   - Added detailed logging for returned rules

4. `README.md`
   - Updated disabled rules documentation

5. `TECHNICAL_DOCUMENTATION.md`
   - Added tag extraction algorithm section
   - Updated function descriptions
   - Updated component documentation

## Future Enhancements

Potential improvements for future consideration:

1. **Automatic Tagging**: When disabling rules via the application, automatically add `disabled-YYYYMMDD` tag
2. **Tag Management**: UI for viewing/editing `disabled-YYYYMMDD` tags on rules
3. **Bulk Tagging**: Tool to add `disabled-YYYYMMDD` tags to existing disabled rules
4. **Custom Tag Format**: Configurable tag format (e.g., `disabled-YYYY-MM-DD` or `disabled_YYYYMMDD`)
5. **Tag History**: Track all `disabled-YYYYMMDD` tags to show disable/enable history
