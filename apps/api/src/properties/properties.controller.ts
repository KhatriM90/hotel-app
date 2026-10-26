import { Body, Controller, Get, Post } from '@nestjs/common';
import { OUTLET_TYPES, REVENUE_CENTRES } from '@hotel/shared';
import { z } from 'zod';
import { CurrentProperty, PropertyScoped, RequirePermission } from '../auth/decorators';
import { ZodPipe } from '../common/zod.pipe';
import { RequestContext } from '../db/request-context';
import { Idempotent } from '../idempotency/idempotency';
import { PropertiesService } from './properties.service';

const CreateOutletSchema = z.object({
  code: z.string().regex(/^[A-Z0-9-]{2,16}$/),
  name: z.string().min(2).max(120),
  type: z.enum(OUTLET_TYPES),
  revenueCentre: z.enum(REVENUE_CENTRES),
  issuingWarehouseCode: z.string().regex(/^[A-Za-z0-9-]{1,8}$/).nullish(), // SAP warehouse code, e.g. "8"
  sellsAlcohol: z.boolean().default(false),
});

type CurrentPropertyT = NonNullable<RequestContext['property']>;

@Controller('properties')
export class PropertiesController {
  constructor(private readonly properties: PropertiesService) {}

  @Get()
  @RequirePermission('property.read')
  list() {
    return this.properties.list();
  }

  @Get(':propertyCode')
  @RequirePermission('property.read')
  @PropertyScoped()
  get(@CurrentProperty() property: CurrentPropertyT) {
    return this.properties.get(property.id);
  }

  @Get(':propertyCode/outlets')
  @RequirePermission('outlet.read')
  @PropertyScoped()
  outlets(@CurrentProperty() property: CurrentPropertyT) {
    return this.properties.listOutlets(property.id);
  }

  @Post(':propertyCode/outlets')
  @RequirePermission('outlet.manage')
  @PropertyScoped()
  @Idempotent()
  createOutlet(
    @CurrentProperty() property: CurrentPropertyT,
    @Body(new ZodPipe(CreateOutletSchema)) body: z.infer<typeof CreateOutletSchema>,
  ) {
    return this.properties.createOutlet(property, body);
  }
}
