import { UserRole } from "@book-shop/contracts";

export interface UserContext {
  userId: string;
  userName: string;
  role: UserRole;
}

export const GRPC_METADATA_KEYS = {
  userId: "x-user-id",
  userName: "x-user-name",
  userRole: "x-user-role",
  traceId: "x-trace-id"
} as const;

export function userContextToMetadata(
  ctx: UserContext
): Record<string, string> {
  return {
    [GRPC_METADATA_KEYS.userId]: ctx.userId,
    [GRPC_METADATA_KEYS.userName]: ctx.userName,
    [GRPC_METADATA_KEYS.userRole]: ctx.role
  };
}

export function userContextFromMetadata(
  metadata: Record<string, string | string[] | undefined>
): UserContext | undefined {
  const userId = metadata[GRPC_METADATA_KEYS.userId];
  const role = metadata[GRPC_METADATA_KEYS.userRole];
  if (!userId || !role) {
    return undefined;
  }
  const userName = metadata[GRPC_METADATA_KEYS.userName];
  return {
    userId: String(userId),
    userName: userName ? String(userName) : "",
    role: String(role) as UserRole
  };
}
