import { describe, it, expect } from "vitest";

const SAMPLE_OUTPUT = `show olt 1 all
-----------------------------------------------------------------------------
  Port  ONU  MAC                State      Software-Ver  Template
 ----------------------------------------------------------------------------
  1     1    80-f7-a6-6c-b4-e0  online     V1.3.8        0(system)
  1     2    e0-e8-e6-7b-60-c5  online     V2.1.13       0(system)
  1     3    70-a5-6a-ff-93-b5  powerdown                0(system)
  1     4    70-a5-6a-ff-9e-d5  online     V1.2.6        0(system)
  1     7    e0-e8-e6-6a-f8-4f  online     V2.1.12       0(system)
  1     9    80-07-1b-07-b5-b0  powerdown                0(system)
  1     12   e0-e8-e6-6a-f7-27  online     V2.1.12       0(system)
  1     18   70-a5-6a-62-99-f1  online     V2.1.14       0(system)
  1     23   60-d2-dd-31-54-a6  online     V1.1.2-220331  0(system)
  1     31   80-f7-a6-39-67-01  online     V1.3.8        0(system)
  1     42   60-d2-dd-33-95-82  powerdown                0(system)
  1     43   e0-e8-e6-6a-f7-d7  online     V2.1.12       0(system)
  1     45   80-f7-a6-0e-a4-36  online     V1.3.8        0(system)
  1     46   80-07-1b-07-9d-f0  online     V3.3.0-201216  0(system)
  1     49   c4-70-0b-4a-93-10  offline                  0(system)
  1     51   e0-e8-e6-ad-3f-da  powerdown                0(system)
  1     53   70-a5-6a-ff-9e-8f  online     V1.2.6        0(system)
  1     57   80-f7-a6-39-59-d5  online     V1.3.8        0(system)
  1     59   70-a5-6a-ff-98-b9  online     V1.2.6        0(system)
  1     60   80-f7-a6-39-66-cb  online     V1.3.8        0(system)
-----------------------------------------------------------------------------
  Total: 20, online 15.`;

export interface EponOnuInfo {
  port: number;
  onuId: number;
  mac: string;
  state: string;
  softwareVer?: string;
}

export function parseEponOnuTable(output: string): EponOnuInfo[] {
  const result: EponOnuInfo[] = [];
  const lines = output.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(
      /^(\d+)\s+(\d+)\s+([0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2})\s+([a-zA-Z]+)(?:\s+([\w\.\-]+))?/
    );
    if (match && match[1] && match[2] && match[3] && match[4]) {
      result.push({
        port: parseInt(match[1], 10),
        onuId: parseInt(match[2], 10),
        mac: match[3].toLowerCase().replace(/-/g, ":"),
        state: match[4].toLowerCase(),
        softwareVer: match[5],
      });
    }
  }

  return result;
}

export function findEponOnu(onus: EponOnuInfo[], query: string): EponOnuInfo | undefined {
  if (!query) return undefined;
  const cleaned = query.replace(/[:\-\.]/g, "").toLowerCase().trim();

  // 1. Match by MAC address
  const byMac = onus.find((o) => o.mac.replace(/[:\-\.]/g, "").toLowerCase() === cleaned);
  if (byMac) return byMac;

  // 2. Match by ONU ID (if query is purely digits)
  if (/^\d+$/.test(query.trim())) {
    const id = parseInt(query.trim(), 10);
    const byId = onus.find((o) => o.onuId === id);
    if (byId) return byId;
  }

  return undefined;
}

describe("C-Data EPON Parser", () => {
  it("parses table correctly", () => {
    const onus = parseEponOnuTable(SAMPLE_OUTPUT);
    expect(onus.length).toBe(20);
    expect(onus[0]).toEqual({
      port: 1,
      onuId: 1,
      mac: "80:f7:a6:6c:b4:e0",
      state: "online",
      softwareVer: "V1.3.8",
    });
    expect(onus[2].state).toBe("powerdown");
    expect(onus[14].state).toBe("offline");
  });

  it("finds ONU by MAC with different formats", () => {
    const onus = parseEponOnuTable(SAMPLE_OUTPUT);
    
    // Con guiones
    const found1 = findEponOnu(onus, "80-f7-a6-6c-b4-e0");
    expect(found1?.onuId).toBe(1);

    // Con dos puntos
    const found2 = findEponOnu(onus, "80:F7:A6:6C:B4:E0");
    expect(found2?.onuId).toBe(1);

    // Sin separador
    const found3 = findEponOnu(onus, "80f7a66cb4e0");
    expect(found3?.onuId).toBe(1);

    // Por ID
    const found4 = findEponOnu(onus, "42");
    expect(found4?.mac).toBe("60:d2:dd:33:95:82");
    expect(found4?.state).toBe("powerdown");
  });
});
