// Module contract — types only, no runtime code (TDD phase).
// The implementation phase provides the real NestJS root module wiring the
// gRPC controller, Prisma repository, OutboxRelay, JwtVerifier and the
// reservation sweeper. Declared (not implemented) so the e2e suite compiles;
// `NestFactory.createMicroservice(AppModule)` fails until then.
export declare class AppModule {}
