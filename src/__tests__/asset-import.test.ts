import { describe, it, expect } from 'vitest';
import { parseAssetCSV, rowToAsset, assetIdentityKey, isNonTechnicalType } from '../lib/asset-import';
import type { Asset } from '../types';

const HEADER = 'id,name,configuration_status_name,archived,configuration_type_name,operating_system_name,primary_ip,serial_number,location_name,contact_name,updated_at,mac_address,asset_tag,manufacturer_name,model_name,notes';

const ROW_SERVER = '86709321,VHQ-NAG-UAT01,Production,No,Managed Server,Windows Server 2022 Standard,10.255.1.179,VMware-42 3d 11 02,"East Rutherford, NJ",Eleni Fantis,2026-07-24T03:12:17.000Z,00-50-56-BD-DB-1A,,,"VMware7,1",';
const ROW_LAPTOP = '79251979,NAG-ACALDER-LT,Production,No,Managed Workstation,Windows 11 Pro,192.168.1.164,5CD2274R5Q,"East Rutherford, NJ",Jim Gallagher,2026-07-09T14:04:50.000Z,E8-FB-1C-58-27-6A,0003178,"HP, Inc.",HP ProBook 450 G9,';

function csv(...rows: string[]) {
  return [HEADER, ...rows].join('\n');
}

describe('rowToAsset', () => {
  it('maps ITGlue configuration columns onto the Asset shape', () => {
    const asset = rowToAsset({
      id: '123',
      name: 'NAG-TEST',
      primary_ip: '10.0.0.5',
      mac_address: '00-50-56-BD-DB-1A',
      serial_number: '5CD43994SX',
      configuration_type_name: 'Managed Workstation',
      configuration_status_name: 'Production',
      operating_system_name: 'Windows 11 Pro',
      location_name: 'East Rutherford, NJ',
      asset_tag: '0003178',
      archived: 'No',
      updated_at: '2026-07-24T03:12:17.000Z',
    }, { importedAt: 1000 });

    expect(asset).toBeDefined();
    expect(asset!.name).toBe('NAG-TEST');
    expect(asset!.externalId).toBe('123');
    expect(asset!.primaryIp).toBe('10.0.0.5');
    expect(asset!.ipAddresses).toEqual(['10.0.0.5']);
    expect(asset!.macAddresses).toEqual(['00-50-56-BD-DB-1A']);
    expect(asset!.assetType).toBe('Managed Workstation');
    expect(asset!.archivedInSource).toBe(false);
    expect(asset!.sourceUpdatedAt).toBe(Date.parse('2026-07-24T03:12:17.000Z'));
  });

  it('drops values that fail their own format check', () => {
    const asset = rowToAsset({ name: 'X', primary_ip: 'not-an-ip', mac_address: 'nope' }, { importedAt: 1 });
    expect(asset!.primaryIp).toBeUndefined();
    expect(asset!.macAddress).toBeUndefined();
    expect(asset!.ipAddresses).toEqual([]);
  });

  it('rejects rows with no name', () => {
    expect(rowToAsset({ id: '1', primary_ip: '10.0.0.1' }, { importedAt: 1 })).toBeUndefined();
  });

  it('falls back to RMM columns when primary columns are blank', () => {
    const asset = rowToAsset({ name: 'X', rmm_name: 'host-a', rmm_serial_number: 'ABC123' }, { importedAt: 1 });
    expect(asset!.hostname).toBe('host-a');
    expect(asset!.serialNumber).toBe('ABC123');
  });
});

describe('assetIdentityKey', () => {
  it('prefers the source system id', () => {
    expect(assetIdentityKey({ externalId: '99', serialNumber: 'S', macAddress: 'M', name: 'N' })).toBe('ext:99');
  });

  it('falls back through serial, MAC, then name+IP', () => {
    expect(assetIdentityKey({ serialNumber: '5CD4', name: 'N' })).toBe('sn:5cd4');
    expect(assetIdentityKey({ macAddress: '00-50-56-BD-DB-1A', name: 'N' })).toBe('mac:005056bddb1a');
    expect(assetIdentityKey({ name: 'Host', primaryIp: '10.0.0.1' })).toBe('name:host|10.0.0.1');
  });

  it('does not treat a VMware BIOS UUID as an identity', () => {
    const key = assetIdentityKey({ serialNumber: 'VMware-42 3d 11', name: 'VM', primaryIp: '10.0.0.2' });
    expect(key).toBe('name:vm|10.0.0.2');
  });
});

describe('non-technical filtering', () => {
  const LIC = '20146205,FileMaker Pro 11,Active,No,"SW/HW Certs, Licenses & Warranties",,,,,,,,,,,';
  const ACC = '24290250,AWS Account,Active,No,Account Information,,,,,,,,,,,';

  it('skips licences and account records by default', () => {
    const result = parseAssetCSV(csv(ROW_SERVER, LIC, ACC), [], { now: 1000 });
    expect(result.created).toBe(1);
    expect(result.skippedNonTechnical).toBe(2);
    expect(result.assets.map((a) => a.name)).toEqual(['VHQ-NAG-UAT01']);
  });

  it('reports the skip count separately from malformed rows', () => {
    const result = parseAssetCSV(csv(LIC, '999,,Active,No,Managed Server,,,,,,,,,,,'), [], { now: 1000 });
    expect(result.skippedNonTechnical).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('can be opted out of', () => {
    const result = parseAssetCSV(csv(ROW_SERVER, LIC), [], { now: 1000, includeNonTechnical: true });
    expect(result.created).toBe(2);
    expect(result.skippedNonTechnical).toBe(0);
  });

  it('matches the type case-insensitively', () => {
    expect(isNonTechnicalType('Account Information')).toBe(true);
    expect(isNonTechnicalType('  account information  ')).toBe(true);
    expect(isNonTechnicalType('Managed Server')).toBe(false);
    expect(isNonTechnicalType(undefined)).toBe(false);
  });
});

describe('parseAssetCSV', () => {
  it('imports rows and reports counts', () => {
    const result = parseAssetCSV(csv(ROW_SERVER, ROW_LAPTOP), [], { source: 'configurations.csv', now: 1000 });
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.assets.map((a) => a.name)).toEqual(['VHQ-NAG-UAT01', 'NAG-ACALDER-LT']);
    expect(result.assets[0].source).toBe('configurations.csv');
  });

  it('upserts on re-import rather than duplicating', () => {
    const first = parseAssetCSV(csv(ROW_SERVER), [], { now: 1000 });
    const changed = ROW_SERVER.replace('10.255.1.179', '10.255.1.180');
    const second = parseAssetCSV(csv(changed), first.assets, { now: 2000 });

    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.assets[0].id).toBe(first.assets[0].id);
    expect(second.assets[0].primaryIp).toBe('10.255.1.180');
    expect(second.assets[0].createdAt).toBe(1000);
    expect(second.assets[0].updatedAt).toBe(2000);
  });

  it('preserves analyst-owned fields across a re-import', () => {
    const first = parseAssetCSV(csv(ROW_LAPTOP), [], { now: 1000 });
    const enriched: Asset[] = [{
      ...first.assets[0],
      tags: ['crown-jewel'],
      clsLevel: 'TLP:AMBER',
      linkedFolderIds: ['case-1'],
      archived: true,
    }];

    const second = parseAssetCSV(csv(ROW_LAPTOP), enriched, { now: 2000 });
    expect(second.assets[0].tags).toEqual(['crown-jewel']);
    expect(second.assets[0].clsLevel).toBe('TLP:AMBER');
    expect(second.assets[0].linkedFolderIds).toEqual(['case-1']);
    expect(second.assets[0].archived).toBe(true);
  });

  it('skips duplicate identities within a single file', () => {
    const result = parseAssetCSV(csv(ROW_SERVER, ROW_SERVER), [], { now: 1000 });
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('skips unnamed rows without failing the import', () => {
    const result = parseAssetCSV(csv(ROW_SERVER, '999,,Production,No,,,10.0.0.9,,,,,,,,,'), [], { now: 1000 });
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('handles an empty file', () => {
    const result = parseAssetCSV(HEADER, [], { now: 1000 });
    expect(result.created).toBe(0);
    expect(result.assets).toEqual([]);
  });

  it('is case-insensitive on headers', () => {
    const result = parseAssetCSV('ID,NAME,Primary_IP\n7,UPPER-HOST,10.0.0.7', [], { now: 1000 });
    expect(result.created).toBe(1);
    expect(result.assets[0].name).toBe('UPPER-HOST');
    expect(result.assets[0].primaryIp).toBe('10.0.0.7');
  });
});
