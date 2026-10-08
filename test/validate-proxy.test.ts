import { describe, it, expect, vi } from "vitest";
import type { StorageLayout } from "../src/types/validation.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../src/plugin/internals/deployment-utils.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/plugin/internals/deployment-utils.js")>();
  return {
    ...orig,
    readDeployment: vi.fn(),
    getContractBuildData: vi.fn(),
    createBuildInfoOutputCache: vi.fn().mockReturnValue({}),
    resolveArtifactName: vi.fn().mockImplementation((_: unknown, name: string) => name),
  };
});

vi.mock("../src/plugin/internals/validations-cache.js", () => ({
  loadValidationsFromDisk: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/plugin/hooks/compile.js", () => ({
  getInMemoryValidations: vi.fn().mockReturnValue(null),
}));

import { validateProxyUpgrade, assertProxyUpgrade } from "../src/proxy/validate-proxy.js";
import { readDeployment, getContractBuildData } from "../src/plugin/internals/deployment-utils.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const layout: StorageLayout = {
  storage: [
    {
      contract: "A",
      label: "value",
      offset: 0,
      slot: "0",
      type: "t_uint256",
      src: "",
    },
  ],
  types: { t_uint256: { label: "uint256", numberOfBytes: "32" } },
};

const layoutWithNewVar: StorageLayout = {
  storage: [
    {
      contract: "A",
      label: "value",
      offset: 0,
      slot: "0",
      type: "t_uint256",
      src: "",
    },
    {
      contract: "A",
      label: "extra",
      offset: 0,
      slot: "1",
      type: "t_uint256",
      src: "",
    },
  ],
  types: { t_uint256: { label: "uint256", numberOfBytes: "32" } },
};

const layoutWithRemovedVar: StorageLayout = {
  storage: [],
  types: {},
};

const layoutWithTypeChangedVar: StorageLayout = {
  storage: [
    {
      contract: "A",
      label: "value",
      offset: 0,
      slot: "0",
      type: "t_uint128",
      src: "",
    },
  ],
  types: { t_uint128: { label: "uint128", numberOfBytes: "16" } },
};

function makeHre(network = "localhost") {
  return {
    globalOptions: { network },
    config: { paths: { root: "/project", cache: "/project/cache" } },
    artifacts: {},
  };
}

function mockBuildData(newLayout: StorageLayout | undefined) {
  vi.mocked(getContractBuildData).mockResolvedValue({
    upgradeStorageLayout: newLayout,
    safetyErrors: [],
    proxyKind: undefined,
  } as never);
}

// ---------------------------------------------------------------------------
// validateProxyUpgrade
// ---------------------------------------------------------------------------

describe("validateProxyUpgrade", () => {
  it("returns ok on first deploy (no existing deployment)", async () => {
    vi.mocked(readDeployment).mockResolvedValue(null);
    mockBuildData(layout);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract");
    expect(result.ok).toBe(true);
  });

  it("throws when the deployment exists but has no baseline (not a first deployment)", async () => {
    vi.mocked(readDeployment).mockResolvedValue({ address: "0xold" } as never);
    mockBuildData(layoutWithNewVar);
    await expect(validateProxyUpgrade(makeHre() as never, "MyContract")).rejects.toThrow(
      /deployed but has no upgradeStorageLayout baseline/,
    );
  });

  it("passes kind to OZ's getErrors via getContractBuildData", async () => {
    vi.mocked(readDeployment).mockResolvedValue(null);
    mockBuildData(layout);
    await validateProxyUpgrade(makeHre() as never, "MyContract", { kind: "uups" });
    expect(vi.mocked(getContractBuildData).mock.lastCall![4]).toMatchObject({ kind: "uups" });
  });

  it("returns ok for a backward-compatible upgrade (append only)", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutWithNewVar);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract");
    expect(result.ok).toBe(true);
    expect(result.storage?.ok).toBe(true);
  });

  it("returns errors when a variable is removed", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutWithRemovedVar);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract");
    expect(result.ok).toBe(false);
    expect(result.storage?.ops.map((op) => op.kind)).toEqual(["delete"]);
  });

  it("respects unsafeSkipStorageCheck", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutWithRemovedVar);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract", {
      unsafeSkipStorageCheck: true,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.kind === "storage-check-skipped")).toBe(true);
  });

  it("fails a type change (no blanket bypass exists)", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutWithTypeChangedVar);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract");
    expect(result.ok).toBe(false);
  });

  it("passes unsafeAllow to OZ's getErrors via getContractBuildData", async () => {
    vi.mocked(readDeployment).mockResolvedValue(null);
    mockBuildData(layout);
    await validateProxyUpgrade(makeHre() as never, "MyContract", {
      unsafeAllow: ["constructor"],
    });
    expect(vi.mocked(getContractBuildData).mock.lastCall![4]).toEqual({
      unsafeAllow: ["constructor"],
    });
  });

  it("fails on a safety error from OZ even when storage is compatible", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    vi.mocked(getContractBuildData).mockResolvedValue({
      upgradeStorageLayout: layoutWithNewVar,
      safetyErrors: [{ kind: "missing-public-upgradeto", src: "contracts/A.sol:1" }],
      proxyKind: "uups",
    } as never);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract");
    expect(result.ok).toBe(false);
    expect(result.safetyErrors.map((e) => e.kind)).toEqual(["missing-public-upgradeto"]);
  });

  it("passes a rename with unsafeAllowRenames", async () => {
    const layoutRenamed: StorageLayout = {
      storage: [
        {
          contract: "A",
          label: "renamedValue",
          offset: 0,
          slot: "0",
          type: "t_uint256",
          src: "",
        },
      ],
      types: { t_uint256: { label: "uint256", numberOfBytes: "32" } },
    };
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutRenamed);
    expect((await validateProxyUpgrade(makeHre() as never, "MyContract")).ok).toBe(false);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract", {
      unsafeAllowRenames: true,
    });
    expect(result.ok).toBe(true);
  });

  it("throws when network is not set", async () => {
    await expect(validateProxyUpgrade(makeHre("") as never, "MyContract")).rejects.toThrow(
      /network/,
    );
  });

  it("throws when new layout is not in validation cache", async () => {
    vi.mocked(readDeployment).mockResolvedValue(null);
    mockBuildData(undefined);
    await expect(validateProxyUpgrade(makeHre() as never, "MyContract")).rejects.toThrow(
      /hardhat compile/,
    );
  });
});

// ---------------------------------------------------------------------------
// assertProxyUpgrade
// ---------------------------------------------------------------------------

describe("assertProxyUpgrade", () => {
  it("does not throw for a safe upgrade", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutWithNewVar);
    await expect(assertProxyUpgrade(makeHre() as never, "MyContract")).resolves.not.toThrow();
  });

  it("does not throw on first deployment (no baseline)", async () => {
    vi.mocked(readDeployment).mockResolvedValue(null);
    mockBuildData(layout);
    await expect(assertProxyUpgrade(makeHre() as never, "MyContract")).resolves.not.toThrow();
  });

  it("throws when the layout is incompatible", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutWithRemovedVar);
    await expect(assertProxyUpgrade(makeHre() as never, "MyContract")).rejects.toThrow();
  });

  it("does not throw when unsafeSkipStorageCheck bypasses all checks", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutWithRemovedVar);
    await expect(
      assertProxyUpgrade(makeHre() as never, "MyContract", {
        unsafeSkipStorageCheck: true,
      }),
    ).resolves.not.toThrow();
  });

  it("does not throw when a rename is covered by unsafeAllowRenames", async () => {
    const layoutRenamed: StorageLayout = {
      storage: [
        {
          contract: "A",
          label: "renamedValue",
          offset: 0,
          slot: "0",
          type: "t_uint256",
          src: "",
        },
      ],
      types: { t_uint256: { label: "uint256", numberOfBytes: "32" } },
    };
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutRenamed);
    await expect(
      assertProxyUpgrade(makeHre() as never, "MyContract", {
        unsafeAllowRenames: true,
      }),
    ).resolves.not.toThrow();
  });

  it("throws when network is not set", async () => {
    await expect(assertProxyUpgrade(makeHre("") as never, "MyContract")).rejects.toThrow(/network/);
  });
});
