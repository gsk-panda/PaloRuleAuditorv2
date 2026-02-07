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

const SSH_TIMEOUT_MS = 300000;

function runSshCommand(
  config: PanoramaSshConfig,
  command: string,
  label?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let output = '';
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error(`SSH timeout${label ? ` (${label})` : ''} after ${SSH_TIMEOUT_MS / 1000}s`));
    }, SSH_TIMEOUT_MS);
    conn
      .on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            return reject(new Error(`SSH exec failed${label ? ` (${label})` : ''}: ${err.message}`));
          }
          stream
            .on('close', (code?: number) => {
              clearTimeout(timeout);
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
      .on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`SSH connection failed${label ? ` (${label})` : ''}: ${err.message}`));
      })
      .connect({
        host: config.host,
        port: config.port ?? 22,
        username: config.username,
        privateKey: config.privateKey || undefined,
        password: config.password || undefined,
      });
  });
}

const SKIP_DEVICE_IDS = new Set(['negate', 'no', 'yes']);
const SERIAL_PATTERN = /^\d{10,}$/;

export function parseConfigureTargets(
  deviceGroup: string,
  output: string
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const lines = output.split('\n');
  let currentRule: string | null = null;
  let inDevices = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ruleMatch = line.match(/^\s*"([^"]+)"\s*\{?\s*$/);
    if (ruleMatch) {
      currentRule = ruleMatch[1];
      inDevices = false;
      continue;
    }
    if (line.includes('devices') && line.includes('{')) {
      inDevices = true;
      continue;
    }
    if (inDevices && currentRule) {
      const devMatch = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*;?\s*$/);
      if (devMatch) {
        const dev = devMatch[1].trim();
        if (dev && !SKIP_DEVICE_IDS.has(dev)) {
          const existing = map.get(currentRule) || [];
          if (!existing.includes(dev)) existing.push(dev);
          map.set(currentRule, existing);
        }
      }
      if (line.trim() === '}' || (line.trim().startsWith('}') && !line.includes('{'))) {
        inDevices = false;
      }
    }
    if (line.trim() === '}' || line.trim() === '};') {
      if (inDevices) inDevices = false;
    }
  }
  return map;
}

const TOTAL_LINE = /Total Hit Count:\s*\d+/;
const HEADER_LINE = /Rule Name\s+Rule usage\s+Device Name/;
const PROMPT_LINE = /^[\w@.-]+\([^)]*\)>\s*$/;
const ANSI_ESCAPE = /\x1b\[[0-9;]*[a-zA-Z]?/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function parseRuleHitCountTable(output: string): SshHitCountRow[] {
  const rows: SshHitCountRow[] = [];
  const cleaned = stripAnsi(output);
  const lines = cleaned.split('\n');
  let currentRule = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TOTAL_LINE.test(line)) continue;
    if (HEADER_LINE.test(line)) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---') || trimmed.startsWith('=~=') || trimmed.startsWith('set cli') || PROMPT_LINE.test(trimmed)) continue;
    const parts = trimmed.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 4) {
      if (parts[0] && parts[0] !== 'Rule' && parts[0] !== 'Rule Name') currentRule = parts[0];
      continue;
    }
    const isDataRow =
      (parts[0] === 'Used' || parts[0] === 'Unused') &&
      parts.length >= 9 &&
      parts[1] &&
      parts[1] !== 'Device Name' &&
      !/^-+$/.test(parts[1]);
    const deviceNameCol = isDataRow ? (parts[1] ?? '') : '';
    const hitCountCol = isDataRow ? (parts[3] ?? '-') : '-';
    let lastHitCol = '-';
    let ruleModifyCol = '-';
    if (isDataRow && parts.length >= 5) {
      const monthAbbrev = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/;
      const timePart = /^\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/;
      const fullDate = /\d{2}:\d{2}:\d{2}\s+\d{4}$/;
      const timestamps: string[] = [];
      let idx = 4;
      while (idx < parts.length && timestamps.length < 6) {
        const p = parts[idx];
        if (p === '-' || p === 'connected') break;
        if (monthAbbrev.test(p) && idx + 1 < parts.length && timePart.test(parts[idx + 1])) {
          timestamps.push(`${p} ${parts[idx + 1]}`);
          idx += 2;
        } else if (p && fullDate.test(p)) {
          timestamps.push(p);
          idx += 1;
        } else {
          idx += 1;
        }
      }
      lastHitCol = timestamps[0] ?? '-';
      ruleModifyCol = timestamps[4] ?? '-';
    }
    if (isDataRow) {
      const ruleName = currentRule;
      if (!ruleName) continue;
      const hitCount = hitCountCol === '-' || hitCountCol === '' ? 0 : parseInt(hitCountCol, 10) || 0;
      rows.push({
        ruleName,
        deviceName: deviceNameCol,
        hitCount,
        lastHitTimestamp: lastHitCol && lastHitCol !== '-' ? lastHitCol : null,
        ruleModifyTimestamp: ruleModifyCol && ruleModifyCol !== '-' ? ruleModifyCol : null,
      });
    } else if (parts[0] && parts[0] !== 'Rule' && parts[0] !== 'Rule Name' && !parts[0].startsWith('---') && parts[0] !== 'Used' && parts[0] !== 'Unused') {
      currentRule = parts[0];
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
  let configureOutput: string;
  try {
    const configureCmd = `show device-group "${deviceGroup}" pre-rulebase security rules`;
    configureOutput = await runSshCommand(sshConfig, configureCmd, `targets-${deviceGroup}`);
  } catch (err) {
    throw new Error(`SSH targets fetch failed for ${deviceGroup}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const targetsByRule = parseConfigureTargets(deviceGroup, configureOutput);

  onProgress?.(`SSH: Getting hit counts for device group ${deviceGroup}...`);
  let hitCountOutput: string;
  try {
    const hitCountCmd = `set cli scripting-mode on
show rule-hit-count device-group "${deviceGroup}" pre-rulebase security rules all
set cli scripting-mode off`;
    hitCountOutput = await runSshCommand(sshConfig, hitCountCmd, `hitcount-${deviceGroup}`);
  } catch (err) {
    throw new Error(`SSH hit count fetch failed for ${deviceGroup}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const hitRows = parseRuleHitCountTable(hitCountOutput);

  const entries: PanoramaRuleUseEntry[] = [];
  const targetsAreSerials = (devices: string[]) =>
    devices.length > 0 && devices.every((d) => SERIAL_PATTERN.test(d));
  for (const row of hitRows) {
    const targetedDevices = targetsByRule.get(row.ruleName);
    const useAllDevices =
      !targetedDevices ||
      targetedDevices.length === 0 ||
      targetsAreSerials(targetedDevices);
    if (!useAllDevices && !targetedDevices!.includes(row.deviceName)) continue;
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
