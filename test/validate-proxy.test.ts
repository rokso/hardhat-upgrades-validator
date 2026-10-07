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

vi.mock("../src/plugin/internals/validations-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/plugin/internals/validations-cache.js")>()),
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
    unsafeAllowFromAnnotation: [],
    perVariableUnsafeAllow: new Map(),
    namespaceUnsafeAllow: new Map(),
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

  it("returns ok when existing deployment has no upgradeStorageLayout", async () => {
    vi.mocked(readDeployment).mockResolvedValue({ address: "0xold" } as never);
    mockBuildData(layoutWithNewVar);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract");
    expect(result.ok).toBe(true);
  });

  it("returns ok for a backward-compatible upgrade (append only)", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutWithNewVar);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract");
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns errors when a variable is removed", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutWithRemovedVar);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract");
    expect(result.ok).toBe(false);
    expect(result.errors[0].kind).toBe("variable-removed");
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

  it("respects unsafeAllow for type-changed", async () => {
    vi.mocked(readDeployment).mockResolvedValue({
      address: "0xold",
      upgradeStorageLayout: layout,
    } as never);
    mockBuildData(layoutWithTypeChangedVar);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract", {
      unsafeAllow: ["type-changed"],
    });
    expect(result.ok).toBe(true);
  });

  it("merges unsafeAllow from options and annotations", async () => {
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
    vi.mocked(getContractBuildData).mockResolvedValue({
      upgradeStorageLayout: layoutRenamed,
      unsafeAllowFromAnnotation: ["type-changed"],
      perVariableUnsafeAllow: new Map(),
      namespaceUnsafeAllow: new Map(),
      safetyErrors: [],
      proxyKind: undefined,
    } as never);
    const result = await validateProxyUpgrade(makeHre() as never, "MyContract", {
      unsafeAllow: ["variable-renamed"],
    });
    expect(result.ok).toBe(true);
  });

  it("throws when network is not set", async () => {
    await expect(validateProxyUpgrade(makeHre("") as never, "MyContract")).rejects.toThrow(
      /network/,
    );
  });

  it("throws the same when --network was not passed, which Hardhat leaves undefined", async () => {
    await expect(
      // (makeHre(undefined) would take its default network.)
      validateProxyUpgrade({ ...makeHre(), globalOptions: {} } as never, "MyContract"),
    ).rejects.toThrow(/Could not determine network/);
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

  it("does not throw when variable-renamed is covered by unsafeAllow", async () => {
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
        unsafeAllow: ["variable-renamed"],
      }),
    ).resolves.not.toThrow();
  });

  it("throws when network is not set", async () => {
    await expect(assertProxyUpgrade(makeHre("") as never, "MyContract")).rejects.toThrow(/network/);
  });
});

// ---------------------------------------------------------------------------
// Offline baseline from the proxy index
// ---------------------------------------------------------------------------

describe("offline, with a proxy index", () => {
  it("throws for an indexed proxy whose implementation has no record, never passing it as new", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { updateProxyEntry } = await import("../src/core/onchain/store.js");
    const { BaselineUnavailableError } = await import("../src/core/onchain/errors.js");

    const root = await mkdtemp(join(tmpdir(), "hhuv-proxyhelper-"));
    try {
      const proxy = "0x00000000000000000000000000000000000000aa";
      await updateProxyEntry(join(root, "deployments", "localhost", ".storage-layouts"), {
        format: 1,
        proxy,
        chainId: 1,
        implementation: "0x00000000000000000000000000000000000000bb",
        deployments: ["MyContract"],
        observedAtBlock: 42,
      });
      vi.mocked(readDeployment).mockResolvedValue({ address: proxy });
      mockBuildData(layout);
      const hre = { ...makeHre(), config: { paths: { root, cache: join(root, "cache") } } };

      await expect(assertProxyUpgrade(hre as never, "MyContract")).rejects.toThrow(
        BaselineUnavailableError,
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
