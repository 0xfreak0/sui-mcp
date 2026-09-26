/**
 * The active validator set, paginated.
 *
 * GraphQL caps a page at 50, and the service answers a larger `first` with
 * `Page size is too large: 200 > 50`, a validation error rather than a
 * truncated page.
 *
 * Mainnet has more than 50 active validators, so a single capped page silently
 * omits some. That turns "is this address a validator" into a coin flip and
 * makes any ranking over the set a ranking of whichever 50 came back first, so
 * the set is paginated rather than clamped to 50.
 */

import { gqlQuery } from "../clients/graphql.js";

/** Max page the GraphQL service will accept. */
const PAGE_SIZE = 50;

/**
 * Upper bound on pages walked, so a service that never reports the end of the
 * connection cannot spin. Sui's validator set is ~150; 20 pages is 1000.
 */
const MAX_PAGES = 20;

export interface ValidatorMetadata {
  sui_address?: string;
  name?: string;
  description?: string;
  image_url?: string;
  project_url?: string;
  net_address?: string;
  p2p_address?: string;
  primary_address?: string;
  worker_address?: string;
}

export interface ValidatorJson {
  metadata?: ValidatorMetadata;
  staking_pool?: {
    id?: string;
    activation_epoch?: string;
    sui_balance?: string;
    pool_token_balance?: string;
  };
  commission_rate?: string;
  next_epoch_commission_rate?: string;
  voting_power?: string;
  gas_price?: string;
  next_epoch_stake?: string;
}

export interface ActiveValidator {
  atRisk?: number;
  contents?: { json: ValidatorJson };
}

export interface ValidatorSet {
  epochId: number | null;
  validators: ActiveValidator[];
  /** Total stake from the validator set object, when the query returned it. */
  totalStake: string | null;
  /**
   * True when MAX_PAGES was hit with more pages outstanding. Callers that rank
   * or count must say so rather than present a partial set as the whole one.
   */
  truncated: boolean;
}

const QUERY = `
  query($first: Int!, $after: String) {
    epoch {
      epochId
      validatorSet {
        activeValidators(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { atRisk contents { json } }
        }
        contents { json }
      }
    }
  }
`;

interface QueryResult {
  epoch: {
    epochId?: number;
    validatorSet: {
      activeValidators: {
        pageInfo: { hasNextPage: boolean; endCursor?: string | null };
        nodes: ActiveValidator[];
      };
      contents?: { json?: { total_stake?: string } };
    };
  };
}

/**
 * Fetch every active validator, walking pages until the connection ends.
 *
 * Throws on a GraphQL failure. Callers that would rather degrade than fail
 * (`identify_address` classifying an address it cannot confirm) should catch,
 * but they must not confuse "the query failed" with "not a validator".
 */
export async function fetchActiveValidators(): Promise<ValidatorSet> {
  const validators: ActiveValidator[] = [];
  let cursor: string | null = null;
  let epochId: number | null = null;
  let totalStake: string | null = null;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data: QueryResult = await gqlQuery<QueryResult>(QUERY, {
      first: PAGE_SIZE,
      after: cursor,
    });

    const set = data.epoch?.validatorSet;
    if (!set) break;
    epochId = data.epoch.epochId ?? epochId;
    totalStake = set.contents?.json?.total_stake ?? totalStake;
    validators.push(...(set.activeValidators.nodes ?? []));

    if (!set.activeValidators.pageInfo.hasNextPage) {
      return { epochId, validators, totalStake, truncated: false };
    }
    cursor = set.activeValidators.pageInfo.endCursor ?? null;
    if (!cursor) break;
    truncated = page === MAX_PAGES - 1;
  }

  return { epochId, validators, totalStake, truncated };
}

/** Find one validator by its Sui address in a fetched set. */
export function findValidatorByAddress(
  set: ValidatorSet,
  address: string,
): ActiveValidator | null {
  return (
    set.validators.find((v) => v.contents?.json?.metadata?.sui_address === address) ?? null
  );
}
