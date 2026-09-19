import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { DocFlowJwtPayload } from './jwt.guard';

/**
 * Mirrors the Prisma `Role` enum so consumers can import it without pulling
 * @prisma/client into the common package.
 */
export enum Role {
  ADMIN = 'ADMIN',
  CONTABILIDADE = 'CONTABILIDADE',
  GESTOR_RH = 'GESTOR_RH',
  OPERADOR = 'OPERADOR',
  APPROVER = 'APPROVER',
  ACCOUNTANT = 'ACCOUNTANT',
}

/**
 * Coarse role check. Resource-level permissions (`canApprovePayments`, etc.)
 * MUST be enforced in services — this guard is only the first filter.
 *
 * Public routes are exempt: if there's no authenticated user there's
 * nothing to check. JwtGuard upstream will already have rejected any
 * authenticated-but-not-public request lacking a valid token.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles?.length) return true;

    const user = context.switchToHttp().getRequest().user as
      | DocFlowJwtPayload
      | undefined;
    const grantedRoles = new Set(user?.roles ?? []);
    if (!requiredRoles.some((role) => grantedRoles.has(role))) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
