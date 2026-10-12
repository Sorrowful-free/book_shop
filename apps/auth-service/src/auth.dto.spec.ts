import "reflect-metadata";
import { describe, expect, it, mock } from "bun:test";
import { status } from "@grpc/grpc-js";
import type { JwtVerifier } from "@book-shop/common";
import { AuthController } from "./auth.controller";
import {
  GetUserDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  requestValidationPipe,
  RevokeTokenDto,
  ValidateTokenDto
} from "./auth.dto";
import type { AuthService } from "./auth.service";

const PASSWORD = "Str0ng!pass";

function grpcCode(error: unknown): number | undefined {
  const err = error as any;
  return err?.code ?? err?.error?.code ?? err?.getError?.()?.code;
}

async function expectInvalidArgument(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(grpcCode(error)).toBe(status.INVALID_ARGUMENT);
    return;
  }
  expect.unreachable("expected INVALID_ARGUMENT");
}

function validate<T>(value: unknown, metatype: new () => T): Promise<T> {
  // Mirrors Nest's payload-pipe invocation for the request argument: RPC
  // @Payload params arrive with RpcParamtype.PAYLOAD (a number ≠ "custom"),
  // so toValidate() proceeds — any non-"custom" type here is equivalent.
  return requestValidationPipe.transform(value, {
    type: "body",
    metatype
  }) as Promise<T>;
}

describe("requestValidationPipe — boundary shape checks (F-A4)", () => {
  it("passes a well-formed RegisterRequest through as a DTO", async () => {
    const dto = await validate(
      { userName: "alice_01", password: PASSWORD },
      RegisterDto
    );
    expect(dto).toBeInstanceOf(RegisterDto);
    expect(dto.userName).toBe("alice_01");
    expect(dto.password).toBe(PASSWORD);
  });

  it.each(["ab", "a".repeat(33), "bad name", "bad-name", "bad.name", ""])(
    "rejects user_name %j with INVALID_ARGUMENT (Register and Login)",
    async (userName) => {
      await expectInvalidArgument(
        validate({ userName, password: PASSWORD }, RegisterDto)
      );
      await expectInvalidArgument(
        validate({ userName, password: PASSWORD }, LoginDto)
      );
    }
  );

  it("carries the same user_name message as the service rule", async () => {
    try {
      await validate({ userName: "bad name", password: PASSWORD }, RegisterDto);
      expect.unreachable("expected INVALID_ARGUMENT");
    } catch (error) {
      const payload = (
        error as { getError?: () => { message?: string } }
      ).getError?.();
      expect(payload?.message).toContain(
        "user_name must be 3-32 chars of [a-zA-Z0-9_]"
      );
    }
  });

  const emptyFieldCases: [string, unknown, new () => object][] = [
    ["register", { userName: "alice_01", password: "" }, RegisterDto],
    ["login", { userName: "alice_01", password: "" }, LoginDto],
    ["refresh", { refreshToken: "" }, RefreshDto],
    ["revokeToken", { refreshToken: "" }, RevokeTokenDto],
    ["validateToken", { accessToken: "" }, ValidateTokenDto],
    ["getUser", { userId: "" }, GetUserDto]
  ];
  it.each(emptyFieldCases)(
    "rejects an empty required field in %s with INVALID_ARGUMENT",
    async (_rpc, request, metatype) => {
      await expectInvalidArgument(validate(request, metatype));
    }
  );

  it("accepts a RevokeTokenRequest without the optional access_token", async () => {
    const dto = await validate({ refreshToken: "jwt-refresh" }, RevokeTokenDto);
    expect(dto).toBeInstanceOf(RevokeTokenDto);
    expect(dto.accessToken).toBeUndefined();
  });

  it("rejects a non-string field (type check) with INVALID_ARGUMENT", async () => {
    await expectInvalidArgument(validate({ userId: 42 }, GetUserDto));
  });
});

describe("boundary validation runs before domain logic", () => {
  function makeController() {
    const service = {
      register: mock(async () => ({})),
      login: mock(async () => ({})),
      refresh: mock(async () => ({})),
      revokeToken: mock(async () => undefined),
      validateToken: mock(async () => ({ valid: false })),
      getUser: mock(async () => ({}))
    };
    const controller = new AuthController(
      service as unknown as AuthService,
      {} as JwtVerifier
    );
    return { controller, service };
  }

  it("an invalid user_name never reaches AuthService.register", async () => {
    const { controller, service } = makeController();
    // Pipe first, then the handler — same order as Nest param binding.
    await expectInvalidArgument(
      validate({ userName: "bad name", password: PASSWORD }, RegisterDto).then(
        (dto) => controller.register(dto)
      )
    );
    expect(service.register).not.toHaveBeenCalled();
  });

  it("an empty access_token never reaches AuthService.validateToken", async () => {
    const { controller, service } = makeController();
    await expectInvalidArgument(
      validate({ accessToken: "" }, ValidateTokenDto).then((dto) =>
        controller.validateToken(dto)
      )
    );
    expect(service.validateToken).not.toHaveBeenCalled();
  });

  it("a valid request passes through to AuthService unchanged", async () => {
    const { controller, service } = makeController();
    const request = { userName: "alice_01", password: PASSWORD };
    const dto = await validate(request, RegisterDto);
    await controller.register(dto);
    expect(service.register).toHaveBeenCalledTimes(1);
    expect(service.register).toHaveBeenCalledWith(dto);
  });
});
