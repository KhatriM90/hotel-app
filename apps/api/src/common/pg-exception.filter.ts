import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseError } from 'pg';

/**
 * Maps database guard errors to HTTP responses so callers get a clear reason
 * instead of a 500 (AT-04 "server rejects it with a clear reason").
 */
const PG_STATUS: Record<string, { status: number; error: string }> = {
  HT001: { status: HttpStatus.CONFLICT, error: 'append_only' },
  HT002: { status: HttpStatus.CONFLICT, error: 'finalised_record' },
  HT003: { status: HttpStatus.FORBIDDEN, error: 'property_scope' },
  HT004: { status: HttpStatus.CONFLICT, error: 'invalid_transition' }, // booking lifecycle (RES-03)
  '23P01': { status: HttpStatus.CONFLICT, error: 'room_unavailable' }, // allocation overlap (RES-04)
  '42501': { status: HttpStatus.FORBIDDEN, error: 'property_scope' }, // RLS WITH CHECK violation
  '23505': { status: HttpStatus.CONFLICT, error: 'duplicate' },
  '23503': { status: HttpStatus.UNPROCESSABLE_ENTITY, error: 'invalid_reference' },
  '23514': { status: HttpStatus.UNPROCESSABLE_ENTITY, error: 'constraint_violation' },
};

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      res.status(exception.getStatus()).json(typeof body === 'string' ? { message: body } : body);
      return;
    }

    if (exception instanceof DatabaseError && exception.code && PG_STATUS[exception.code]) {
      const mapped = PG_STATUS[exception.code];
      res.status(mapped.status).json({
        statusCode: mapped.status,
        error: mapped.error,
        message: exception.message,
        ...(exception.hint ? { hint: exception.hint } : {}),
      });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, message: 'Internal server error' });
  }
}
