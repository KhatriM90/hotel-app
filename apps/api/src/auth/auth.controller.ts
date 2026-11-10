import { Body, Controller, Get, Headers, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../common/zod.pipe';
import { AuthUser } from '../db/request-context';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from './decorators';

const LoginSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(1).max(256),
});

const PinLoginSchema = z.object({
  userId: z.string().uuid(),
  pin: z.string().regex(/^\d{4,6}$/),
});

const SetPinSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  pin: z.string().regex(/^\d{4,6}$/, 'A PIN is 4 to 6 digits'),
});

/** Header a registered POS tablet sends with its device token. */
export const DEVICE_HEADER = 'x-pos-device';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>) {
    return this.auth.login(body.username, body.password);
  }

  /** A registered tablet: its settings and the staff who can sign in on it with a PIN. */
  @Public()
  @Get('pos-device')
  async posDevice(@Headers(DEVICE_HEADER) token?: string) {
    const device = await this.auth.deviceByToken(token);
    if (!device) {
      throw new UnauthorizedException({ statusCode: 401, error: 'device_not_registered', message: 'This tablet is not registered for PIN sign-in' });
    }
    return { device: this.auth.deviceView(device), staff: await this.auth.deviceStaff(device) };
  }

  /** PIN sign-in on a registered tablet; five wrong PINs lock that user's PIN for five minutes. */
  @Public()
  @Post('pin-login')
  @HttpCode(200)
  pinLogin(@Headers(DEVICE_HEADER) token: string | undefined, @Body(new ZodPipe(PinLoginSchema)) body: z.infer<typeof PinLoginSchema>) {
    return this.auth.pinLogin(token, body.userId, body.pin);
  }

  /** Sets or changes the caller's own POS PIN (confirmed with their password). */
  @Post('pin')
  @HttpCode(200)
  setPin(@CurrentUser() user: AuthUser, @Body(new ZodPipe(SetPinSchema)) body: z.infer<typeof SetPinSchema>) {
    return this.auth.setOwnPin(user.id, body.currentPassword, body.pin);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
