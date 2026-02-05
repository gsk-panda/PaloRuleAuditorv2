import { Client } from 'ssh2';

export interface PanoramaSshConfig {
  host: string;
  port?: number;
  username: string;
  privateKey?: string;
  password?: string;
}

export interface SshRuleTargets {
  ruleName: string;
  devices: string[];
}

export interface SshHitCountRow {
  ruleName: string;
  deviceName: string;
  hitCount: number;
  lastHitTimestamp: string | null;
  ruleModifyTimestamp: string | null;
}

function runSshCommand(
  config: PanoramaSshConfig,
  command: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          stream
            .on('close', () => {
              conn.end();
              resolve(output);
            })
            .on('data', (data: Buffer) => {
              output += data.toString('utf8');
            })
            .stderr?.on('data', (data: Buffer) => {
              output += data.toString('utf8');
            });
        });
      })
      .on('error', reject)
      .connect({
        host: config.host,
        port: config.port ?? 22,
        username: config.username,
        privateKey: config.privateKey || undefined,
        password: config.password || undefined,
      });
  });
}

export function parseConfigureTargets(
  deviceGroup: string,
  output: string
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const setLineRegex = new RegExp(
    `set\\s+device-group\\s+${escapeRegex(deviceGroup)}\\s+pre-rulebase\\s+security\\s+rules\\s+"([^"]+)"\\s+target\\s+devices\\s+\\[\\s*([^\\]]*)\\s*\\]`,
    'gi'
  );
  let m: RegExpExecArray | null;
  while ((m = setLineRegex.exec(output)) !== null) {
    const ruleName = m[1];
    const devicesStr = m[2].trim();
    const devices = devicesStr ? devicesStr.split(/\s+/).filter(Boolean) : [];
    map.set(ruleName, devices);
  }
  const continuationRegex = new RegExp(
    `(?:target\\s+)?devices\\s+\\[\\s*([^\\]]*)\\s*\\]`,
    'gi'
  );
  let currentRule: string | null = null;
  const lines = output.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ruleMatch = line.match(
      new RegExp(`rules\\s+"([^"]+)"`, 'i')
    );
    if (ruleMatch) currentRule = ruleMatch[1];
    const devMatch = line.match(/target\s+devices\s+\[\s*([^\]]*)\s*\]/i) || line.match(/devices\s+\[\s*([^\]]*)\s*\]/i);
    if (currentRule && devMatch) {
      const devices = devMatch[1].trim().split(/\s+/).filter(Boolean);
      if (devices.length > 0) {
        const existing = map.get(currentRule) || [];
        map.set(currentRule, [...existing, ...devices]);
      }
      currentRule = null;
    }
  }
  return map;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TOTAL_LINE = /Total Hit Count:\s*\d+/;
const HEADER_LINE = /Rule Name\s+Rule usage\s+Device Name/;

export function parseRuleHitCountTable(output: string): SshHitCountRow[] {
  const rows: SshHitCountRow[] = [];
  const lines = output.split('\n');
  let currentRule = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TOTAL_LINE.test(line)) continue;
    if (HEADER_LINE.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---')) continue;
    const parts = trimmed.split(/\s{2,}/).map((p) => p.trim());
    if (parts.length < 5) {
      if (parts[0] && parts[0] !== 'Rule Name') currentRule = parts[0];
      continue;
    }
    const ruleNameCol = parts[0];
    const ruleUsageCol = parts[1] ?? '';
    const deviceNameCol = parts[2] ?? '';
    const hitCountCol = parts[4] ?? '-';
    const lastHitCol = parts[5] ?? '-';
    const ruleModifyCol = parts[9] ?? '-';
    if (deviceNameCol && deviceNameCol !== 'Device Name' && !/^-+$/.test(deviceNameCol) && (ruleUsageCol === 'Used' || ruleUsageCol === 'Unused')) {
      const ruleName = ruleNameCol && ruleNameCol !== 'Rule Name' ? ruleNameCol : currentRule;
      if (!ruleName) continue;
      if (ruleNameCol && ruleNameCol !== 'Rule Name') currentRule = ruleNameCol;
      const hitCount = hitCountCol === '-' || hitCountCol === '' ? 0 : parseInt(hitCountCol, 10) || 0;
      rows.push({
        ruleName,
        deviceName: deviceNameCol,
        hitCount,
        lastHitTimestamp: lastHitCol && lastHitCol !== '-' ? lastHitCol : null,
        ruleModifyTimestamp: ruleModifyCol && ruleModifyCol !== '-' ? ruleModifyCol : null,
      });
    } else if (ruleNameCol && ruleNameCol !== 'Rule Name' && !ruleNameCol.startsWith('---')) {
      currentRule = ruleNameCol;
    }
  }
  return rows;
}

function parsePanosDate(s: string): Date | null {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export interface PanoramaRuleUseEntry {
  devicegroup?: string;
  rulename?: string;
  lastused?: string;
  hitcnt?: string;
  target?: string[];
  modificationTimestamp?: string;
}

export async function getHitCountsViaSsh(
  sshConfig: PanoramaSshConfig,
  deviceGroup: string,
  onProgress?: (message: string) => void
): Promise<PanoramaRuleUseEntry[]> {
  onProgress?.(`SSH: Getting targets for device group ${deviceGroup}...`);
  const configureCmd = `configure
show device-group "${deviceGroup}" pre-rulebase security rules
exit`;
  const configureOutput = await runSshCommand(sshConfig, configureCmd);
  const targetsByRule = parseConfigureTargets(deviceGroup, configureOutput);

  onProgress?.(`SSH: Getting hit counts for device group ${deviceGroup}...`);
  const hitCountCmd = `set cli scripting-mode on
show rule-hit-count device-group "${deviceGroup}" pre-rulebase security rules all
set cli scripting-mode off`;
  const hitCountOutput = await runSshCommand(sshConfig, hitCountCmd);
  const hitRows = parseRuleHitCountTable(hitCountOutput);

  const entries: PanoramaRuleUseEntry[] = [];
  const targetedRuleNames = new Set(targetsByRule.keys());
  for (const row of hitRows) {
    const targetedDevices = targetsByRule.get(row.ruleName);
    if (!targetedDevices || targetedDevices.length === 0) continue;
    if (!targetedDevices.includes(row.deviceName)) continue;
    const hitCount = row.hitCount;
    let lastUsedDate: string | undefined;
    if (hitCount > 0 && row.lastHitTimestamp) {
      const d = parsePanosDate(row.lastHitTimestamp);
      lastUsedDate = d ? d.toISOString() : undefined;
    }
    if (!lastUsedDate && row.ruleModifyTimestamp) {
      const d = parsePanosDate(row.ruleModifyTimestamp);
      lastUsedDate = d ? d.toISOString() : undefined;
    }
    entries.push({
      devicegroup: deviceGroup,
      rulename: row.ruleName,
      lastused: lastUsedDate,
      hitcnt: String(hitCount),
      target: [row.deviceName],
      modificationTimestamp: row.ruleModifyTimestamp || undefined,
    });
  }
  return entries;
}
