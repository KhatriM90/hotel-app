import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';

export interface PropertyDto {
  id: string;
  code: string;
  name: string;
  location: string;
  isHeadOffice: boolean;
  currency: string;
  timezone: string;
  businessDayCutoff: string;
  currentBusinessDate: string;
  sapBranchId: number | null;
  sapDimension1: string;
}

export interface OutletDto {
  id: string;
  propertyId: string;
  code: string;
  name: string;
  type: string;
  revenueCentre: string;
  issuingWarehouseCode: string | null;
  sellsAlcohol: boolean;
  isActive: boolean;
  sapOutletName: string | null;
  sapDimension2Code: string | null;
}

export interface CreateOutletInput {
  code: string;
  name: string;
  type: string;
  revenueCentre: string;
  issuingWarehouseCode?: string | null;
  sellsAlcohol: boolean;
}

const PROPERTY_COLUMNS = `
  id, code, name, location, is_head_office AS "isHeadOffice", currency, timezone,
  to_char(business_day_cutoff, 'HH24:MI') AS "businessDayCutoff",
  current_business_date::text AS "currentBusinessDate",
  sap_branch_id AS "sapBranchId", sap_dimension1 AS "sapDimension1"`;

const OUTLET_COLUMNS = `
  id, property_id AS "propertyId", code, name, type, revenue_centre AS "revenueCentre",
  issuing_warehouse_code AS "issuingWarehouseCode", sells_alcohol AS "sellsAlcohol", is_active AS "isActive",
  sap_outlet_name AS "sapOutletName", sap_dimension2_code AS "sapDimension2Code"`;

@Injectable()
export class PropertiesService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** Only properties visible under the caller's scope (RLS). */
  async list(): Promise<PropertyDto[]> {
    const { rows } = await this.db.query<PropertyDto>(
      `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE is_active ORDER BY is_head_office DESC, code`,
    );
    return rows;
  }

  async get(id: string): Promise<PropertyDto> {
    const { rows } = await this.db.query<PropertyDto>(`SELECT ${PROPERTY_COLUMNS} FROM properties WHERE id = $1`, [id]);
    return rows[0];
  }

  async listOutlets(propertyId: string): Promise<OutletDto[]> {
    const { rows } = await this.db.query<OutletDto>(
      `SELECT ${OUTLET_COLUMNS} FROM outlets WHERE property_id = $1 ORDER BY code`,
      [propertyId],
    );
    return rows;
  }

  async createOutlet(property: { id: string; code: string }, input: CreateOutletInput): Promise<OutletDto> {
    if (!input.code.startsWith(`${property.code}-`)) {
      throw new BadRequestException(`Outlet code must start with "${property.code}-"`);
    }
    return this.db.tx(async (q) => {
      // SAP-14: each outlet issues from exactly one SAP warehouse of its own property.
      if (input.issuingWarehouseCode) {
        const wh = await q.query('SELECT 1 FROM warehouses WHERE sap_code = $1 AND property_id = $2 AND is_active', [
          input.issuingWarehouseCode,
          property.id,
        ]);
        if (!wh.rowCount) {
          throw new BadRequestException(`SAP warehouse ${input.issuingWarehouseCode} does not belong to ${property.code} (SAP-14)`);
        }
      }
      const { rows } = await q.query<OutletDto>(
        `INSERT INTO outlets (property_id, code, name, type, revenue_centre, issuing_warehouse_code, sells_alcohol)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${OUTLET_COLUMNS}`,
        [
          property.id,
          input.code,
          input.name,
          input.type,
          input.revenueCentre,
          input.issuingWarehouseCode ?? null,
          input.sellsAlcohol,
        ],
      );
      await this.audit.record({
        action: 'outlet.create',
        entityType: 'outlet',
        entityId: rows[0].id,
        propertyId: property.id,
        newValues: rows[0],
      });
      return rows[0];
    });
  }
}
