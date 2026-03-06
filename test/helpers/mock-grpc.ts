import { vi } from "vitest";

// Mock gRPC client — returns configurable responses for each service method.
// Usage: call `mockGrpc({ ledgerService: { getServiceInfo: () => ({ response: ... }) } })`
// before importing modules that use `../clients/grpc.js`.

export interface MockSuiClient {
  ledgerService: {
    getServiceInfo: ReturnType<typeof vi.fn>;
    getObject: ReturnType<typeof vi.fn>;
    getTransaction: ReturnType<typeof vi.fn>;
    getCheckpoint: ReturnType<typeof vi.fn>;
    getEpoch: ReturnType<typeof vi.fn>;
  };
  stateService: {
    getCoinInfo: ReturnType<typeof vi.fn>;
  };
  movePackageService: {
    getPackage: ReturnType<typeof vi.fn>;
  };
  nameService: {
    lookupName: ReturnType<typeof vi.fn>;
    reverseLookupName: ReturnType<typeof vi.fn>;
  };
  getBalance: ReturnType<typeof vi.fn>;
  listBalances: ReturnType<typeof vi.fn>;
  listOwnedObjects: ReturnType<typeof vi.fn>;
  listCoins: ReturnType<typeof vi.fn>;
  listDynamicFields: ReturnType<typeof vi.fn>;
  getTransaction: ReturnType<typeof vi.fn>;
  getMoveFunction: ReturnType<typeof vi.fn>;
  simulateTransaction: ReturnType<typeof vi.fn>;
}

export function createMockClient(): MockSuiClient {
  return {
    ledgerService: {
      getServiceInfo: vi.fn(),
      getObject: vi.fn(),
      getTransaction: vi.fn(),
      getCheckpoint: vi.fn(),
      getEpoch: vi.fn(),
    },
    stateService: {
      getCoinInfo: vi.fn(),
    },
    movePackageService: {
      getPackage: vi.fn(),
    },
    nameService: {
      lookupName: vi.fn(),
      reverseLookupName: vi.fn(),
    },
    getBalance: vi.fn(),
    listBalances: vi.fn(),
    listOwnedObjects: vi.fn(),
    listCoins: vi.fn(),
    listDynamicFields: vi.fn(),
    getTransaction: vi.fn(),
    getMoveFunction: vi.fn(),
    simulateTransaction: vi.fn(),
  };
}

export function createMockGraphql() {
  return vi.fn();
}
