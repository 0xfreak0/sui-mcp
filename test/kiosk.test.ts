import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGqlQuery = vi.fn();
vi.mock("../src/clients/graphql.js", () => ({ gqlQuery: mockGqlQuery }));

const { findEnclosingKiosk, resolveKioskCapHolder, unresolvedCapHolderNote } = await import("../src/utils/kiosk.js");

const KIOSK = "0x306b2b5bcec1a7d1a4e780dce1f418fba11f21081575f42c261d09de5eedfd90";
const WRAPPER = "0x2f699d7454664e560f970930efa106e0556c3d2a0cf34781db9a5b033ae724f4";
const CAP = "0x0785656e67232a0a5d9f895d980e7ab0dffc982fb83ac7c7e4d19d2068855fcc";
const ORIGINAL_HOLDER = "0x2237921ac0071178d803f913ae9e487ee772a1a3d20bad6e430e88b29d8074b1";
const CURRENT_HOLDER = "0x5ecf90fa681d13629e91067782316d89893c5cede1b889d7e2ea4eabd0e54088";
const CREATION_TX = "5cfiNwdFJ2FiiJJpBsL4HMqvLfnh6RbcdQNaRMANkeXJ";

beforeEach(() => {
  mockGqlQuery.mockReset();
});

describe("findEnclosingKiosk", () => {
  it("reaches a kiosk two hops up: the dynamic-field wrapper, then the kiosk", async () => {
    mockGqlQuery.mockImplementation(async (_q: string, vars: { id: string }) => {
      if (vars.id === WRAPPER) {
        return {
          object: {
            asMoveObject: { contents: { type: { repr: "0x2::dynamic_field::Field<...>" } } },
            owner: { __typename: "ObjectOwner", address: { address: KIOSK } },
          },
        };
      }
      if (vars.id === KIOSK) {
        return { object: { asMoveObject: { contents: { type: { repr: "0x2::kiosk::Kiosk" } } }, owner: { __typename: "Shared" } } };
      }
      throw new Error(`unexpected id ${vars.id}`);
    });
    const kiosk = await findEnclosingKiosk(WRAPPER);
    expect(kiosk).toBe(KIOSK);
  });

  it("does not attribute a Bag or TableVec parent as a kiosk", async () => {
    mockGqlQuery.mockImplementation(async () => ({
      object: {
        asMoveObject: { contents: { type: { repr: "0x2::bag::Bag" } } },
        owner: { __typename: "AddressOwner", address: { address: "0xsomeone" } },
      },
    }));
    expect(await findEnclosingKiosk("0xbag")).toBeNull();
  });

  it("stops rather than looping past maxHops", async () => {
    let calls = 0;
    mockGqlQuery.mockImplementation(async () => {
      calls++;
      return {
        object: {
          asMoveObject: { contents: { type: { repr: "0x2::dynamic_field::Field<...>" } } },
          owner: { __typename: "ObjectOwner", address: { address: `0xnext${calls}` } },
        },
      };
    });
    const kiosk = await findEnclosingKiosk("0xstart", 2);
    expect(kiosk).toBeNull();
    expect(calls).toBe(2);
  });
});

describe("resolveKioskCapHolder", () => {
  it("reaches the current cap holder through the kiosk's creation transaction", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions")) {
        expect(vars.id).toBe(KIOSK);
        return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION_TX } }] } };
      }
      if (query.includes("objectChanges")) {
        expect(vars.d).toBe(CREATION_TX);
        return {
          transaction: {
            effects: {
              objectChanges: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    address: "0xsomeone-elses-cap",
                    outputState: {
                      owner: { __typename: "AddressOwner", address: { address: "0xnobody" } },
                      asMoveObject: { contents: { type: { repr: "0x2::kiosk::KioskOwnerCap" }, json: { for: "0xa-different-kiosk" } } },
                    },
                  },
                  {
                    address: CAP,
                    outputState: {
                      owner: { __typename: "AddressOwner", address: { address: ORIGINAL_HOLDER } },
                      asMoveObject: { contents: { type: { repr: "0x2::kiosk::KioskOwnerCap" }, json: { for: KIOSK } } },
                    },
                  },
                ],
              },
            },
          },
        };
      }
      // CURRENT_OWNER_QUERY
      expect(vars.id).toBe(CAP);
      return { object: { owner: { __typename: "AddressOwner", address: { address: CURRENT_HOLDER } } } };
    });

    const r = await resolveKioskCapHolder(KIOSK);
    expect(r).toEqual({
      status: "resolved",
      result: {
        cap_id: CAP,
        creation_tx: CREATION_TX,
        original_holder: { kind: "address", address: ORIGINAL_HOLDER },
        holder: { kind: "address", address: CURRENT_HOLDER },
      },
    });
  });

  it("reports creation_unreachable when the kiosk has no retained history", async () => {
    mockGqlQuery.mockResolvedValue({ objectVersions: { nodes: [] } });
    expect(await resolveKioskCapHolder(KIOSK)).toEqual({ status: "creation_unreachable" });
  });

  it("reports cap_not_found rather than guessing when no created cap names this kiosk", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("objectVersions")) {
        return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION_TX } }] } };
      }
      return {
        transaction: {
          effects: {
            objectChanges: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          },
        },
      };
    });
    expect(await resolveKioskCapHolder(KIOSK)).toEqual({ status: "cap_not_found", scanned_pages: 1, truncated: false });
  });

  /**
   * A personal kiosk's `KioskOwnerCap` is wrapped inside a `PersonalKioskCap`
   * the wallet owns, so the cap is no longer a top-level object. GraphQL
   * renders the wrapped cap inline as a nested struct, `cap: { id, for }`,
   * rather than a bare id string. Shapes as mainnet returns them for kiosk
   * 0xc113d13a… and its wrap transaction. The wrapper is found from the
   * cap's own LAST TOUCH, not its creation transaction: a kiosk can be made
   * personal long after both.
   */
  const CAP_WRAP_TX = "ETWxb5VdHPRaoh2wfMHKmQ1YRi3PMD5UD2dV6GAWn1XZ";
  const PERSONAL_CAP = "0x000178977f54a2c3ab3cfe9ca5db8abfb6e46f0bcc4d84cb7f72a222e727da3a";
  const PERSONAL_TYPE = "0x0cb4bcc0560340eb1a1b929cabe56b33fc6449820ec8c1980d69bb98b649b802::personal_kiosk::PersonalKioskCap";
  const creationPage = {
    transaction: {
      effects: {
        objectChanges: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              address: CAP,
              outputState: {
                owner: { __typename: "AddressOwner", address: { address: ORIGINAL_HOLDER } },
                asMoveObject: { contents: { type: { repr: "0x2::kiosk::KioskOwnerCap" }, json: { id: CAP, for: KIOSK } } },
              },
            },
          ],
        },
      },
    },
  };
  const page = (...nodes: unknown[]) => ({
    transaction: { effects: { objectChanges: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } },
  });
  // The wrap transaction as the service returns it: the cap itself appears
  // with an input state and no output state (it stopped being top-level),
  // the kiosk is mutated, and the `personal_kiosk::OwnerMarker` field's
  // `value` names the same wallet as a plain address.
  const wrapTxPage = page(
    { address: CAP, outputState: null },
    {
      address: KIOSK,
      outputState: {
        owner: { __typename: "Shared" },
        asMoveObject: { contents: { type: { repr: "0x2::kiosk::Kiosk" }, json: { id: KIOSK, owner: CURRENT_HOLDER, item_count: 0 } } },
      },
    },
    {
      address: PERSONAL_CAP,
      outputState: {
        owner: { __typename: "AddressOwner", address: { address: CURRENT_HOLDER } },
        asMoveObject: { contents: { type: { repr: PERSONAL_TYPE }, json: { id: PERSONAL_CAP, cap: { id: CAP, for: KIOSK } } } },
      },
    },
  );

  it("resolves the wallet owning the PersonalKioskCap that wraps the cap, and names the wrapper", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions")) {
        return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION_TX } }] } };
      }
      if (query.includes("transactions(filter")) {
        expect(vars.id).toBe(CAP);
        return { transactions: { nodes: [{ digest: CAP_WRAP_TX }] } };
      }
      if (query.includes("objectChanges")) return vars.d === CREATION_TX ? creationPage : wrapTxPage;
      if (vars.id === CAP) return { object: null };
      expect(vars.id).toBe(PERSONAL_CAP);
      // The wrapper's current state, contents included: it still holds the cap.
      return {
        object: {
          owner: { __typename: "AddressOwner", address: { address: CURRENT_HOLDER } },
          asMoveObject: { contents: { json: { id: PERSONAL_CAP, cap: { id: CAP, for: KIOSK } } } },
        },
      };
    });

    const r = await resolveKioskCapHolder(KIOSK);
    expect(r).toEqual({
      status: "resolved",
      result: {
        cap_id: CAP,
        creation_tx: CREATION_TX,
        original_holder: { kind: "address", address: ORIGINAL_HOLDER },
        holder: { kind: "address", address: CURRENT_HOLDER },
        wrapped_in: [{ object_id: PERSONAL_CAP, type: PERSONAL_TYPE }],
      },
    });
  });

  /**
   * A wrapper that is itself wrapped: each level is found from the previous
   * wrapper's last touch, the chain is stated innermost first, and the
   * holder is the owner of the first TOP-LEVEL wrapper. A struct naming the
   * previous wrapper only by an `ID` key (`kiosk::Item { id }`-shaped) is
   * a reference, not a wrapping, and must not match.
   */
  it("follows a wrapper that is itself wrapped, stating the chain innermost first", async () => {
    const OUTER = "0x00000000000000000000000000000000000000000000000000000000000000aa";
    const OUTER_TX = "outerWrapTx";
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions")) {
        return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION_TX } }] } };
      }
      if (query.includes("transactions(filter")) {
        return { transactions: { nodes: [{ digest: vars.id === CAP ? CAP_WRAP_TX : OUTER_TX }] } };
      }
      if (query.includes("objectChanges")) {
        if (vars.d === CREATION_TX) return creationPage;
        if (vars.d === CAP_WRAP_TX) return wrapTxPage;
        return page(
          {
            address: "0x00000000000000000000000000000000000000000000000000000000000000bb",
            outputState: {
              owner: { __typename: "ObjectOwner", address: { address: KIOSK } },
              asMoveObject: { contents: { type: { repr: "0x2::dynamic_field::Field<0x2::kiosk::Item, bool>" }, json: { name: { id: PERSONAL_CAP }, value: true } } },
            },
          },
          {
            address: OUTER,
            outputState: {
              owner: { __typename: "AddressOwner", address: { address: CURRENT_HOLDER } },
              asMoveObject: { contents: { type: { repr: "0xvault::vault::Vault" }, json: { id: OUTER, inner: { id: PERSONAL_CAP, cap: { id: CAP, for: KIOSK } } } } },
            },
          },
        );
      }
      if (vars.id === OUTER) {
        return {
          object: {
            owner: { __typename: "AddressOwner", address: { address: CURRENT_HOLDER } },
            asMoveObject: { contents: { json: { id: OUTER, inner: { id: PERSONAL_CAP, cap: { id: CAP, for: KIOSK } } } } },
          },
        };
      }
      return { object: null }; // the cap and the PersonalKioskCap are both wrapped
    });

    const r = await resolveKioskCapHolder(KIOSK);
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.result.holder).toEqual({ kind: "address", address: CURRENT_HOLDER });
    expect(r.result.wrapped_in).toEqual([
      { object_id: PERSONAL_CAP, type: PERSONAL_TYPE },
      { object_id: OUTER, type: "0xvault::vault::Vault" },
    ]);
  });

  it("keeps the wrappers found so far and a note when the chain cannot be followed to a top-level object", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions")) {
        return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION_TX } }] } };
      }
      if (query.includes("transactions(filter")) {
        return { transactions: { nodes: vars.id === CAP ? [{ digest: CAP_WRAP_TX }] : [] } };
      }
      if (query.includes("objectChanges")) return vars.d === CREATION_TX ? creationPage : wrapTxPage;
      return { object: null };
    });

    const r = await resolveKioskCapHolder(KIOSK);
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.result.holder).toBeNull();
    expect(r.result.wrapped_in).toEqual([{ object_id: PERSONAL_CAP, type: PERSONAL_TYPE }]);
    expect(unresolvedCapHolderNote(r.result)).toContain(PERSONAL_CAP);
  });

  /** The cap is gone AND no wrapper can be found either: null, not a guess. */
  it("reports a null holder when the cap no longer exists and no wrapper is found", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions")) {
        return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION_TX } }] } };
      }
      if (query.includes("transactions(filter")) {
        return { transactions: { nodes: [] } }; // no last touch found either
      }
      if (query.includes("objectChanges")) {
        return {
          transaction: {
            effects: {
              objectChanges: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    address: CAP,
                    outputState: {
                      owner: { __typename: "AddressOwner", address: { address: ORIGINAL_HOLDER } },
                      asMoveObject: { contents: { type: { repr: "0x2::kiosk::KioskOwnerCap" }, json: { for: KIOSK } } },
                    },
                  },
                ],
              },
            },
          },
        };
      }
      expect(vars.id).toBe(CAP);
      return { object: null };
    });
    const r = await resolveKioskCapHolder(KIOSK);
    expect(r).toEqual({
      status: "resolved",
      result: { cap_id: CAP, creation_tx: CREATION_TX, original_holder: { kind: "address", address: ORIGINAL_HOLDER }, holder: null },
    });
  });

  /**
   * A failed read (a 429, a timeout) degrades to `lookup_failed` instead of
   * throwing, so callers (`get_object`, `identify_address`,
   * `trace_object_history`) keep the object answer they already have.
   */
  it("degrades to lookup_failed instead of throwing when a read fails", async () => {
    mockGqlQuery.mockRejectedValue(new Error("429 Too Many Requests"));
    expect(await resolveKioskCapHolder(KIOSK)).toEqual({ status: "lookup_failed", message: "429 Too Many Requests" });
  });
});

/**
 * Caps that never appear as a top-level object in the kiosk's creation
 * transaction. Ids and shapes are as mainnet returns them.
 */
describe("resolveKioskCapHolder — a cap wrapped in the transaction that created it", () => {
  const PK_PKG = "0x0cb4bcc0560340eb1a1b929cabe56b33fc6449820ec8c1980d69bb98b649b802";
  const PERSONAL_TYPE = `${PK_PKG}::personal_kiosk::PersonalKioskCap`;
  const KIOSK_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::kiosk::Kiosk";
  const shared = { __typename: "Shared" };
  const addressOwner = (a: string) => ({ __typename: "AddressOwner", address: { address: a } });
  const objectOwner = (a: string) => ({ __typename: "ObjectOwner", address: { address: a } });
  const change = (address: string, outputState: unknown) => ({ address, outputState });
  const moveObj = (owner: unknown, repr: string, json: unknown) => ({ owner, asMoveObject: { contents: { type: { repr }, json } } });
  const onePage = (...nodes: unknown[]) => ({
    transaction: { effects: { objectChanges: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } },
  });
  const ownerMarker = (id: string, kiosk: string, wallet: string) =>
    change(id, moveObj(objectOwner(kiosk), `0x2::dynamic_field::Field<${PK_PKG}::personal_kiosk::OwnerMarker,address>`, { id, name: { dummy_field: false }, value: wallet }));

  /**
   * `kiosk::new` and `personal_kiosk::new` in one PTB (kiosk 0x697240b8…,
   * transaction AMAYoexT…) create and wrap the cap together, so the cap row
   * has no output state and only the PersonalKioskCap embeds it. The
   * PersonalKioskCap's owner is the kiosk's controller.
   */
  it("finds the cap inside the PersonalKioskCap the same transaction created, and names that wrapper's owner", async () => {
    const KIOSK = "0x697240b841f3379087031f30f2562fcae06b1882710897f2e0fe4a2ec695fa34";
    const CAP = "0x1fd3d4acbfca75448c8c1c86b82f00304b6414ff05b7ec64c281a640e10f3834";
    const PKC = "0xa1f15f7aa9c4a4cbbd3359f6949b5044217ceac2f4003832a216a68319dbe07d";
    const WALLET = "0xb830b84f6f513cd63d64f499432e574aedb3f08715983ca8caf73ebaaa0b7348";
    const CREATION = "AMAYoexTCZtN63maCTAUWSFiVTSU65Z5LcpUUZe7xDsc";
    const pkcJson = { id: PKC, cap: { id: CAP, for: KIOSK } };
    const creationPage = onePage(
      change(CAP, null),
      change(KIOSK, moveObj(shared, KIOSK_TYPE, { id: KIOSK, profits: "0", owner: WALLET, item_count: 1, allow_extensions: false })),
      change(PKC, moveObj(addressOwner(WALLET), PERSONAL_TYPE, pkcJson)),
      ownerMarker("0xc1b39a367299024b136cd55f36bc1df60a6cebc213e74f7cc513c21373e33fc5", KIOSK, WALLET),
    );
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions")) return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION } }] } };
      if (query.includes("transactions(filter")) {
        expect(vars.id).toBe(CAP);
        return { transactions: { nodes: [{ digest: CREATION }] } };
      }
      if (query.includes("objectChanges")) return creationPage;
      if (vars.id === CAP) return { object: null };
      expect(vars.id).toBe(PKC);
      return { object: { owner: addressOwner(WALLET), asMoveObject: { contents: { json: pkcJson } } } };
    });

    expect(await resolveKioskCapHolder(KIOSK)).toEqual({
      status: "resolved",
      result: {
        cap_id: CAP,
        creation_tx: CREATION,
        original_holder: { kind: "address", address: WALLET },
        holder: { kind: "address", address: WALLET },
        wrapped_in: [{ object_id: PKC, type: PERSONAL_TYPE }],
      },
    });
  });

  /**
   * Kiosk 0x34c6a1c8…: its cap was created inside a shared `battle::Battle`
   * (Fy7rv5Uq…), and a later transaction (Bq3RMhiv…) deleted the Battle and
   * moved the cap into a new PersonalKioskCap. That move never touches the
   * cap, so its last touch still names the Battle; the Battle's own last
   * touch is where the cap went.
   */
  const KIOSK = "0x34c6a1c8e03b039bf6d7e52edbe3d2c64c0ab6e12eafbb5a0a51479b13060b50";
  const CAP = "0x6aa9bc22dede1bab60539ce69bdb2e1123476121843f8e02397da75a0222b63f";
  const BATTLE = "0xf4e7fff9788e4578f0dc4dc7357a2d3e6ebcb8bd2287f9e37b9d6f6d34682ea4";
  const BATTLE_TYPE = "0xf93a91b13f4970927444b4f47dc86b53e66a3bdd5fac4e9de7e727b8a5efc4e9::battle::Battle";
  const PKC = "0xc2fe9dea6951d68880dd3ae3c48cf4dbbf78beab27c2e8b9e80544e66556dee1";
  const WALLET = "0xf1371a51efc72e117a370e59827f4369838c2d5dc43ddffaf4d681a9fe9d23aa";
  const CREATION = "Fy7rv5UqNNKgK1xDTZTBRPUJhj3f2zoMiHqHsBVL5tDP";
  const MOVE_TX = "Bq3RMhiviy983MR7z4tfsRSAjv8bHiWi81b4hVMebwzc";
  const battleJson = (withCap: boolean) => ({
    id: BATTLE,
    vault_name: "Pokémon $25 Pack",
    participants: [WALLET],
    cards: [],
    ...(withCap ? { kiosk_owner_cap: { id: CAP, for: KIOSK } } : {}),
  });
  const pkcJson = { id: PKC, cap: { id: CAP, for: KIOSK } };
  const creationPage = onePage(
    change(KIOSK, moveObj(shared, KIOSK_TYPE, { id: KIOSK, profits: "0", owner: WALLET, item_count: 0, allow_extensions: false })),
    change(CAP, null),
    change(BATTLE, moveObj(shared, BATTLE_TYPE, battleJson(true))),
  );

  it("follows a cap its creation wrapper later handed to a PersonalKioskCap", async () => {
    const movePage = onePage(
      change(BATTLE, null),
      ownerMarker("0xad3a95895362b71d95258d3d0b122d3cd6b068c352a795c9570669c65f895535", KIOSK, WALLET),
      change(PKC, moveObj(addressOwner(WALLET), PERSONAL_TYPE, pkcJson)),
    );
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions")) return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION } }] } };
      if (query.includes("transactions(filter")) return { transactions: { nodes: [{ digest: vars.id === CAP ? CREATION : MOVE_TX }] } };
      if (query.includes("objectChanges")) return vars.d === CREATION ? creationPage : movePage;
      if (vars.id === PKC) return { object: { owner: addressOwner(WALLET), asMoveObject: { contents: { json: pkcJson } } } };
      return { object: null }; // the cap is wrapped and the Battle deleted
    });

    const r = await resolveKioskCapHolder(KIOSK);
    expect(r).toEqual({
      status: "resolved",
      result: {
        cap_id: CAP,
        creation_tx: CREATION,
        original_holder: { kind: "shared" },
        holder: { kind: "address", address: WALLET },
        wrapped_in: [{ object_id: PKC, type: PERSONAL_TYPE }],
      },
    });
  });

  /** The same Battle, still live, still holding the cap: its owner is named. */
  it("names the creation wrapper's owner while it still holds the cap", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions")) return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION } }] } };
      if (query.includes("transactions(filter")) return { transactions: { nodes: [{ digest: CREATION }] } };
      if (query.includes("objectChanges")) return creationPage;
      if (vars.id === BATTLE) return { object: { owner: shared, asMoveObject: { contents: { json: battleJson(true) } } } };
      return { object: null };
    });
    const r = await resolveKioskCapHolder(KIOSK);
    expect(r.status === "resolved" && r.result.holder).toEqual({ kind: "shared" });
    expect(r.status === "resolved" && r.result.wrapped_in).toEqual([{ object_id: BATTLE, type: BATTLE_TYPE }]);
  });

  /**
   * The Battle still exists but no longer holds the cap, and its last write
   * names no new container: its owner must not be named as the controller.
   */
  it("does not name a wrapper the cap has left, and says the cap moved out of it", async () => {
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions")) return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION } }] } };
      if (query.includes("transactions(filter")) return { transactions: { nodes: [{ digest: vars.id === CAP ? CREATION : "laterBattleTx" }] } };
      if (query.includes("objectChanges")) {
        return vars.d === CREATION ? creationPage : onePage(change(BATTLE, moveObj(shared, BATTLE_TYPE, battleJson(false))));
      }
      if (vars.id === BATTLE) return { object: { owner: shared, asMoveObject: { contents: { json: battleJson(false) } } } };
      return { object: null };
    });

    const r = await resolveKioskCapHolder(KIOSK);
    expect(r.status).toBe("resolved");
    if (r.status !== "resolved") return;
    expect(r.result.holder).toBeNull();
    expect(r.result.wrapped_in).toBeUndefined();
    expect(r.result.cap_left).toEqual({ object_id: BATTLE, type: BATTLE_TYPE });
    expect(unresolvedCapHolderNote(r.result)).toMatch(/no longer holds it/);
  });

  /** A struct with `for` naming this kiosk but more fields than a cap is not a KioskOwnerCap. */
  it("does not take a larger struct that merely names the kiosk for the cap", async () => {
    mockGqlQuery.mockImplementation(async (query: string) => {
      if (query.includes("objectVersions")) return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION } }] } };
      if (query.includes("objectChanges")) {
        return onePage(change(BATTLE, moveObj(shared, BATTLE_TYPE, { id: BATTLE, listing: { id: CAP, for: KIOSK, price: "5" } })));
      }
      throw new Error(`unexpected query: ${query.slice(0, 40)}`);
    });
    expect(await resolveKioskCapHolder(KIOSK)).toEqual({ status: "cap_not_found", scanned_pages: 1, truncated: false });
  });

  it("follows the cap out of a wrapper that still exists, through that wrapper's last write", async () => {
    const movePage = onePage(
      change(BATTLE, moveObj(shared, BATTLE_TYPE, battleJson(false))),
      change(PKC, moveObj(addressOwner(WALLET), PERSONAL_TYPE, pkcJson)),
    );
    mockGqlQuery.mockImplementation(async (query: string, vars: Record<string, unknown>) => {
      if (query.includes("objectVersions")) return { objectVersions: { nodes: [{ previousTransaction: { digest: CREATION } }] } };
      if (query.includes("transactions(filter")) return { transactions: { nodes: [{ digest: vars.id === CAP ? CREATION : MOVE_TX }] } };
      if (query.includes("objectChanges")) return vars.d === CREATION ? creationPage : movePage;
      if (vars.id === BATTLE) return { object: { owner: shared, asMoveObject: { contents: { json: battleJson(false) } } } };
      if (vars.id === PKC) return { object: { owner: addressOwner(WALLET), asMoveObject: { contents: { json: pkcJson } } } };
      return { object: null };
    });
    const r = await resolveKioskCapHolder(KIOSK);
    expect(r.status === "resolved" && r.result.holder).toEqual({ kind: "address", address: WALLET });
    expect(r.status === "resolved" && r.result.wrapped_in).toEqual([{ object_id: PKC, type: PERSONAL_TYPE }]);
    expect(r.status === "resolved" && r.result.cap_left).toBeUndefined();
  });
});
