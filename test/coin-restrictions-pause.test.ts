import { describe, it, expect, vi, beforeEach } from "vitest";
import { gqlPage } from "./helpers/service-shapes.js";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));
vi.mock("../src/clients/grpc.js", () => ({ sui: {} }));

const { readCoinRestrictions } = await import("../src/utils/deny-list-probe.js");

const JDSG = "0x9e7418ee528d661e13ab50c65ccb12350e3f18c934e5205a929a2a8df3ec7031::jdsg::JDSG";
const CONFIG = "0xa6033620ccedcd7c6d8464eae0782ef2f75c854aba0b5a94f1ac155398d7f34e";
const FROZEN = "0xfec5c2c656b521b036ac95ecbdaa036eaf5acc69a078a8fb32a5d92c6e6eb181";

/** A Config dynamic field as GraphQL returns it: key type and json, Setting<bool> value. */
const field = (keyType: string, keyJson: unknown, newerValue: boolean) => ({
  name: { type: { repr: `0x0000000000000000000000000000000000000000000000000000000000000002::deny_list::${keyType}` }, json: keyJson },
  value: { __typename: "MoveValue", json: { data: { newer_value_epoch: "1056", newer_value: newerValue, older_value_opt: null } } },
});

beforeEach(() => mockGqlQuery.mockReset());

describe("readCoinRestrictions: the whole-coin pause", () => {
  it("is false when every field was read and none is a pause", async () => {
    // JDSG's Config on mainnet: three AddressKey settings and no GlobalPauseKey.
    mockGqlQuery.mockResolvedValue({ object: { dynamicFields: gqlPage([field("AddressKey", { pos0: FROZEN }, true)]) } });

    const r = await readCoinRestrictions(JDSG, CONFIG, 1261);

    expect(r.globally_paused).toBe(false);
    expect(r.denied.map((d) => d.address)).toEqual([FROZEN]);
  });

  it("is the setting's value when the issuer set one", async () => {
    mockGqlQuery.mockResolvedValue({ object: { dynamicFields: gqlPage([field("GlobalPauseKey", { dummy_field: false }, true)]) } });

    expect((await readCoinRestrictions(JDSG, CONFIG, 1261)).globally_paused).toBe(true);
  });

  it("stays unknown when the fields could not be read to the end", async () => {
    mockGqlQuery.mockResolvedValue({ object: null });

    expect((await readCoinRestrictions(JDSG, CONFIG, 1261)).globally_paused).toBeNull();
  });
});
