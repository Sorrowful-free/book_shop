/**
 * Root NestJS module — TYPE DECLARATION ONLY (TDD contract phase).
 * The implementation wires: Prisma-backed AuthRepository, TokenService,
 * ioredis denylist writer, JwtVerifier, OutboxRelay (lazy Kafka producer so
 * the service boots with the broker down), seed admin, AuthService gRPC
 * controller (authProto.AuthServiceControllerMethods).
 */
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- NestJS modules are intentionally empty; the real one carries @Module()
export declare class AppModule {}
