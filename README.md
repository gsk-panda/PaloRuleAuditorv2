# Palo Alto Panorama Rule Auditor

A comprehensive web application for auditing, analyzing, and managing firewall rules in Palo Alto Networks Panorama deployments. Identify unused rules, manage disabled rules, and automate remediation with confidence through detailed dry-run reports and AI-powered analysis.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage Guide](#usage-guide)
- [Audit Modes](#audit-modes)
- [Remediation Options](#remediation-options)
- [Export & Reporting](#export--reporting)
- [AI Analysis](#ai-analysis)
- [High Availability (HA) Pair Support](#high-availability-ha-pair-support)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Security Considerations](#security-considerations)

## Overview

Palo Alto Panorama Rule Auditor helps network administrators:

- **Identify unused firewall rules** that haven't been hit in a specified number of days
- **Find disabled rules** that have been disabled for extended periods
- **Analyze rule usage patterns** across device groups and managed firewalls
- **Automate remediation** with production mode for disabling or deleting rules
- **Generate comprehensive reports** in PDF format for documentation and compliance
- **Leverage AI analysis** for security impact assessment and recommendations

The application provides a modern web interface with dry-run capabilities, ensuring you can review all changes before applying them to your Panorama configuration.

## Features

### Core Functionality

- **Dual Audit Modes**
  - **Find Unused Rules**: Identifies rules with no hits within a configurable threshold (default: 90 days)
  - **Find Disabled Rules**: Locates rules that have been disabled for more than a specified period

- **Production & Dry-Run Modes**
  - **Dry-Run Mode**: Generate reports without making any changes to Panorama
  - **Production Mode**: Apply remediation actions (disable/delete rules) with automatic tagging and commit

- **Selective Remediation**
  - Checkbox selection for individual rules
  - All rules selected by default (can be unchecked)
  - Bulk operations with visual feedback

- **Comprehensive Reporting**
  - Real-time audit summaries with statistics
  - Detailed rule listings with hit counts and timestamps
  - Device group discovery and display
  - PDF export with full audit details and AI analysis

- **AI-Powered Analysis**
  - Security impact assessment using Google Gemini AI
  - Recommendations for rule management
  - Example API commands for remediation actions

- **High Availability Support**
  - HA pair definition via text file upload
  - Intelligent rule evaluation (both firewalls must show 0 hits for remediation)
  - Visual HA pair grouping in rule display

- **Device Group Management**
  - Automatic discovery of all device groups
  - Pre-rulebase security rule analysis
  - Shared device group filtering (automatically ignored)

### Technical Features

- **Modern Web Interface**: Built with React and TailwindCSS
- **RESTful API**: Express.js backend with TypeScript
- **XML API Integration**: Direct integration with Panorama XML API
- **Real-time Status**: Live progress indicators and status updates
- **Error Handling**: Comprehensive error reporting and logging
- **Responsive Design**: Works on desktop and tablet devices

## Prerequisites

- **Node.js**: Version 18 or higher
- **Palo Alto Panorama**: Accessible via HTTPS with XML API enabled
- **Panorama API Key**: Valid API key with appropriate permissions
- **Network Access**: Ability to reach Panorama management interface from the application server

### Required Panorama Permissions

The API key must have permissions to:
- Read device group configurations
- Read security rule configurations
- Query operational data (rule-hit-count)
- Modify security rules (for production mode)
- Create and manage tags (for production mode)
- Commit configuration changes (for production mode)

## Installation

### Development Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/gsk-panda/PaloRuleAuditorv2.git
   cd PaloRuleAuditor
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   Create a `.env.local` file (optional for AI features):
   ```bash
   API_KEY=your_gemini_api_key_here
   ```

4. **Start the development server:**
   ```bash
   npm run dev
   ```

   This starts both the frontend (Vite) on `http://localhost:3000` and the backend (Express) on `http://localhost:3001`.

### Production Installation (RHEL 9)

For production deployment on RHEL 9, use the provided installation script:

```bash
sudo ./install-rhel9.sh
```

The script will:
- Create a dedicated system user (`panoruleauditor`)
- Set up the application in `/opt/PaloRuleAuditor`
- Configure systemd service for automatic startup
- Set up proper file permissions
- Configure the application to run on system boot

After installation, manage the service with:

```bash
# Start the service
sudo systemctl start panoruleauditor

# Stop the service
sudo systemctl stop panoruleauditor

# Restart the service
sudo systemctl restart panoruleauditor

# Check status
sudo systemctl status panoruleauditor

# View logs
sudo journalctl -u panoruleauditor -f
```

## Configuration

### Panorama Connection Settings

Access the application and configure:

1. **Panorama URL**: The HTTPS URL of your Panorama management interface
   - Example: `https://panorama.example.com`
   - Must be accessible from the application server

2. **API Key**: Your Panorama XML API key
   - Generate in Panorama: **Device** → **Setup** → **Management** → **XML API Setup**
   - Ensure the key has appropriate permissions (see Prerequisites)

3. **Unused Threshold (Days)**: Number of days of inactivity to consider a rule unused
   - Default: 90 days
   - Only applies to "Find Unused Rules" mode

4. **Disabled Threshold (Days)**: Number of days a rule must be disabled to appear in results
   - Default: 90 days
   - Only applies to "Find Disabled Rules" mode

### HA Pairs Configuration

For "Find Unused Rules" mode, you can upload a text file defining High Availability pairs:

**File Format:**
```
firewall1:firewall2
fw-primary:fw-secondary
pa-01:pa-02
```

**Rules:**
- One pair per line
- Format: `firewall1:firewall2`
- Both firewalls in a pair must show 0 hits for a rule to be eligible for remediation
- Rules are visually grouped by HA pair in the results table

## Usage Guide

### Basic Workflow

1. **Configure Connection**
   - Enter Panorama URL and API key
   - Select audit mode (Unused Rules or Disabled Rules)
   - Set threshold days

2. **Generate Audit Report**
   - Click "Generate Dry Run Report" (or "Find Disabled Rules" for disabled mode)
   - Wait for the audit to complete (progress shown in real-time)
   - Review the summary statistics

3. **Review Results**
   - Examine the detailed rule table
   - Check device groups discovered
   - Review hit statistics and last hit dates
   - Use checkboxes to select/deselect rules for remediation (disabled rules mode only)

4. **Optional: AI Analysis**
   - Click "AI Security Commentary" button
   - Review AI-generated security impact assessment
   - Use recommendations to inform remediation decisions

5. **Export Report (Optional)**
   - Click "Export PDF" to generate a comprehensive PDF report
   - Includes summary, rule details, and AI analysis (if generated)

6. **Apply Remediation (Production Mode)**
   - Enable "Production Mode" checkbox
   - Review selected rules
   - Click "Apply Remediation" button
   - Confirm the action
   - Monitor progress and review results

### Audit Modes

#### Find Unused Rules

Identifies security rules that haven't been hit within the specified threshold period.

**Process:**
1. Discovers all device groups in Panorama
2. Fetches pre-rulebase security rules from each device group
3. Queries hit counts and last-hit timestamps for each rule
4. Filters out rules from "Shared" device group
5. Filters out rules with the same name as Shared rules
6. Identifies rules with 0 hits or last hit beyond threshold
7. Handles rules with `last-hit-timestamp = 0` by using `rule-modification-timestamp`

**Remediation Actions:**
- **DISABLE**: Rules with 0 hits across all targets (or both HA pair members). For HA pairs, both must have 0 hits.
- **UNTARGET**: Rules with hits on some targets but not others (non-HA targets only). HA pairs are protected if either member has hits.
- **HA-PROTECTED**: Rules targeted to HA pairs where either firewall has hits. Both firewalls are protected from disable/untarget.
- **KEEP**: Rules with recent hits (non-HA targets)
- **IGNORE**: Rules from Shared device group

#### Find Disabled Rules

Locates rules that have been disabled for more than the specified threshold.

**Process:**
1. Discovers all device groups in Panorama
2. Fetches pre-rulebase security rules
3. Filters for rules with `<disabled>yes</disabled>`
4. Queries rule-hit-count API to get `rule-modification-timestamp` (disabled date)
5. Identifies rules disabled longer than threshold
6. Displays disabled date instead of last hit date

**Remediation Actions:**
- **DELETE**: Selected rules are permanently deleted from Panorama
- Checkbox selection allows choosing which rules to delete
- All rules selected by default

### Production Mode vs Dry-Run Mode

#### Dry-Run Mode (Default)
- **No changes made** to Panorama configuration
- Generate reports and analyze results safely
- Review all proposed actions before applying
- Perfect for initial audits and planning

#### Production Mode
- **Applies remediation actions** to Panorama
- For unused rules: Disables rules and adds date-based tags
- For disabled rules: Deletes selected rules
- Automatically commits changes to Panorama
- **Requires explicit confirmation** before proceeding
- Shows progress and results after completion

**Production Mode Workflow:**
1. Enable "Production Mode" checkbox
2. Generate audit report (or use existing report)
3. Review selected rules (uncheck any you want to skip)
4. Click "Apply Remediation" button
5. Confirm the action in the dialog
6. Monitor progress (button shows "Applying..." state)
7. Review success/error messages

## Remediation Options

### Disabling Unused Rules

When in "Find Unused Rules" mode with Production Mode enabled:

1. **Rule Disabling**
   - Sets `<disabled>yes</disabled>` on identified rules
   - Uses Panorama XML API `action=set` command

2. **Tag Management**
   - Creates tag if it doesn't exist: `disabled-YYYYMMDD` (e.g., `disabled-20260117`)
   - Adds tag to disabled rules
   - Preserves existing tags on rules

3. **Commit**
   - Automatically commits changes with descriptive message
   - Format: `"Disabled X unused firewall rules and added tag disabled-YYYYMMDD"`

### Deleting Disabled Rules

When in "Find Disabled Rules" mode with Production Mode enabled:

1. **Rule Selection**
   - Checkboxes allow selecting which rules to delete
   - All rules selected by default
   - Uncheck rules you want to keep

2. **Rule Deletion**
   - Permanently deletes selected rules from Panorama
   - Uses Panorama XML API `action=delete` command
   - Cannot be undone (rules are removed from configuration)

3. **Commit**
   - Automatically commits changes with descriptive message
   - Format: `"Deleted X disabled firewall rules"`

## Export & Reporting

### PDF Export

Generate comprehensive PDF reports with:

- **Header Information**
  - Report title and generation timestamp
  - Panorama URL and threshold settings

- **Summary Statistics**
  - Total rules analyzed
  - Rules to disable/delete
  - Rules to untarget
  - HA-protected rules
  - Ignored shared rules
  - Rules to keep active

- **Device Groups**
  - List of all device groups discovered during audit

- **Detailed Rule Table**
  - Rule names and device groups
  - Hit counts and last hit dates
  - Proposed actions

- **AI Analysis** (if generated)
  - Security impact assessment
  - Recommendations
  - Example API commands

**Usage:**
1. Generate an audit report
2. Optionally run AI analysis
3. Click "Export PDF" button
4. PDF downloads automatically with filename: `panorama-audit-YYYY-MM-DD.pdf`

### On-Screen Reports

The web interface displays:

- **Summary Cards**: Visual statistics with color coding
- **Device Groups Panel**: Discovered device groups with badges
- **Detailed Rule Table**: Sortable table with all rule information
- **Hit Statistics**: Total hits and last hit dates per rule
- **Target Status**: HA pair awareness and target status indicators
- **Action Badges**: Color-coded proposed actions

## AI Analysis

### Google Gemini Integration

The application integrates with Google Gemini AI to provide security analysis and recommendations.

**Features:**
- Analyzes all rules in the audit results
- Identifies rules that should be disabled
- Identifies rules needing partial untargeting
- Provides security impact assessment
- Generates example API commands
- Returns analysis in Markdown format

**Requirements:**
- Optional: Set `API_KEY` environment variable with Gemini API key
- If not configured, AI analysis button is still available but will show "unavailable" message

**Usage:**
1. Generate an audit report
2. Click "AI Security Commentary" button
3. Wait for analysis (button shows "Analyzing..." state)
4. Review the generated analysis in the expanded panel
5. Analysis is included in PDF exports if generated

## High Availability (HA) Pair Support

### Overview

The application intelligently handles High Availability firewall pairs to prevent service disruption.

### How It Works

1. **HA Pair Definition**
   - Upload a text file with firewall pairs
   - Format: `firewall1:firewall2` (one per line)
   - Only required for "Find Unused Rules" mode

2. **Rule Evaluation Logic**
   - **Protection Rule**: If **EITHER** firewall in an HA pair shows hits, **BOTH** firewalls are protected from disable/untarget
   - For rules targeted to HA pairs: **Both** firewalls must show 0 hits to be eligible for remediation
   - If one firewall has hits, the rule is marked as "HA-PROTECTED" (both firewalls protected)
   - If both have hits, the rule is marked as "HA-PROTECTED"
   - If both have 0 hits, the rule is marked as "DISABLE"

3. **Visual Display**
   - HA pairs are grouped together in the results table
   - Format: `firewall1 : firewall2` with visual separator
   - Color coding indicates hit status:
     - Blue: Has hits
     - Red with strikethrough: No hits

### Example HA Pair File

```
pa-fw-01:pa-fw-02
primary-fw:secondary-fw
datacenter-a:datacenter-b
```

## API Reference

### Backend Endpoints

#### `POST /api/audit`

Performs an audit for unused rules.

**Request Body:**
```json
{
  "url": "https://panorama.example.com",
  "apiKey": "your_api_key",
  "unusedDays": 90,
  "haPairs": [
    { "fw1": "firewall1", "fw2": "firewall2" }
  ]
}
```

**Response:**
```json
{
  "rules": [
    {
      "id": "rule-id",
      "name": "Rule Name",
      "deviceGroup": "device-group-name",
      "totalHits": 0,
      "lastHitDate": "2024-01-01T00:00:00.000Z",
      "targets": [...],
      "action": "DISABLE",
      "isShared": false
    }
  ],
  "deviceGroups": ["dg1", "dg2"]
}
```

#### `POST /api/audit/disabled`

Performs an audit for disabled rules.

**Request Body:**
```json
{
  "url": "https://panorama.example.com",
  "apiKey": "your_api_key",
  "disabledDays": 90
}
```

**Response:** Same format as `/api/audit`

#### `POST /api/remediate`

Applies remediation actions to Panorama.

**Request Body:**
```json
{
  "url": "https://panorama.example.com",
  "apiKey": "your_api_key",
  "rules": [
    {
      "name": "Rule Name",
      "deviceGroup": "device-group-name"
    }
  ],
  "tag": "disabled-20260117",
  "auditMode": "unused" | "disabled"
}
```

**Response:**
```json
{
  "disabledCount": 5,
  "deletedCount": 0,
  "totalRules": 5,
  "errors": []
}
```

#### `GET /health`

Health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

### Panorama XML API Integration

The application uses the following Panorama XML API operations:

- **Configuration Read**: `type=config&action=get`
- **Configuration Set**: `type=config&action=set`
- **Configuration Delete**: `type=config&action=delete`
- **Operational Query**: `type=op` (for rule-hit-count)
- **Commit**: `type=commit`

## Troubleshooting

### Common Issues

#### "API error: 401 Unauthorized"
- **Cause**: Invalid or expired API key
- **Solution**: Generate a new API key in Panorama and update the configuration

#### "Failed to perform audit"
- **Cause**: Network connectivity issues or Panorama unreachable
- **Solution**: Verify Panorama URL is correct and accessible from the application server

#### "No rules found"
- **Cause**: No rules match the criteria, or device groups have no rules
- **Solution**: Verify device groups exist and contain security rules in pre-rulebase

#### "Port 3001 is already in use"
- **Cause**: Another process is using the backend port
- **Solution**: Stop the existing process or change the PORT environment variable

#### Rules showing 0 hits but API shows hits
- **Cause**: Hit count data may be nested in `device-vsys` entries
- **Solution**: The application handles this automatically; if issues persist, check Panorama API response format

#### Production mode not applying changes
- **Cause**: API key may lack write permissions
- **Solution**: Verify API key has permissions to modify rules, create tags, and commit changes

### Debugging

Enable detailed logging by checking:
- Browser console (F12) for frontend errors
- Server logs: `journalctl -u panoruleauditor -f` (production)
- Server console (development mode)

### Performance Considerations

- **Large Deployments**: Audits may take several minutes for environments with many device groups and rules
- **API Rate Limiting**: Panorama may rate-limit API requests; the application includes delays between requests
- **Memory Usage**: Large audits may consume significant memory; ensure adequate server resources

## Security Considerations

### API Key Security

- **Never commit API keys** to version control
- **Use environment variables** or secure configuration management
- **Rotate API keys** regularly
- **Limit API key permissions** to minimum required
- **Monitor API key usage** in Panorama logs

### Network Security

- **Use HTTPS** for all Panorama connections
- **Restrict network access** to Panorama management interface
- **Use firewall rules** to limit application server access
- **Consider VPN** for remote access scenarios

### Production Mode Safety

- **Always test in dry-run mode first**
- **Review all selected rules** before applying remediation
- **Have a rollback plan** (rules can be re-enabled manually)
- **Monitor Panorama logs** after applying changes
- **Verify changes** in Panorama UI after remediation

### Data Privacy

- **Audit reports** may contain sensitive rule names and configurations
- **Secure PDF exports** appropriately
- **Limit access** to the application to authorized personnel only
- **Log access** and remediation actions for audit purposes

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

[Specify your license here]

## Support

For issues, questions, or feature requests:
- Open an issue on GitHub
- Contact the development team

## Changelog

### Version History

- **Latest**: Added checkbox selection for disabled rules, delete functionality, improved error handling
- **Previous**: Initial release with unused rules auditing, AI analysis, PDF export

---

**Note**: This application interacts directly with your Panorama configuration. Always test in a non-production environment first and maintain backups of your Panorama configuration.
