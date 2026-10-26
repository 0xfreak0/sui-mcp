#!/usr/bin/env node
/** Check launch discovery and event amounts against raw SuiPump events on mainnet. */
import { startServer, gql, checker } from './lib/mcp-client.mjs';

const ROOT = '0xb205fea41ccedac051bc66498e6ca68cb802c4a6ea06da12e524bed09c80d9b0';
const { ck, finish } = checker();
const tip = (await gql('{checkpoint{sequenceNumber}}')).checkpoint.sequenceNumber;
const server = await startServer({ name: 'launch-pass' });
try {
 let checked = false;
 for (let page = 0; page < 12 && !checked; page++) {
  const lo = tip - 3_000_000 - page * 200_000;
  const hi = lo + 200_000;
  const events = (await gql('query($type:String!,$lo:UInt53!,$hi:UInt53!){events(filter:{type:$type,afterCheckpoint:$lo,beforeCheckpoint:$hi},first:50){nodes{transaction{digest sender{address}} contents{json}}}}', { type: `${ROOT}::bonding_curve::CurveCreated`, lo, hi })).events?.nodes ?? [];
  for (const event of events.slice(0, 4)) {
   const curve = event.contents?.json?.curve_id;
   if (!/^0x[0-9a-f]{64}$/.test(curve ?? '')) continue;
   const object = await gql('query($address:SuiAddress!){object(address:$address){asMoveObject{contents{type{repr}}}}}', { address: curve });
   const coin = /^.+::bonding_curve::Curve<(.+)>$/.exec(object.object?.asMoveObject?.contents?.type?.repr ?? '')?.[1];
   if (!coin) continue;
   const msg = await server.callRaw('analyze_launch', { coin_type: coin, max_pages: 20 }, 180000);
   const result = JSON.parse(msg.result?.content?.[0]?.text ?? '{}');
   if (result.error || !result.discovered_buyers?.length) continue;
   ck('curve, creator, creation transaction match raw event', result.creator?.curve_id === curve && result.creator?.creation_tx === event.transaction.digest && result.creator?.address === event.transaction.sender?.address);
   const first = result.discovered_buyers.find(b => b.buy_events?.length)?.buy_events[0];
   const transaction = await gql('query($digest:String!){transaction(digest:$digest){effects{events(first:50){nodes{contents{type{repr} json}}}}}}', { digest: first.digest });
   const chainEvent = transaction.transaction?.effects?.events?.nodes?.find(e => e.contents?.type?.repr?.endsWith('::bonding_curve::TokensPurchased') && e.contents.json?.curve_id === curve && e.contents.json?.buyer);
   ck('first buyer event amount equals independent raw event', Boolean(chainEvent && String(Number(chainEvent.contents.json.sui_in) / 1e9) === String(first.sui_in) && String(Number(chainEvent.contents.json.tokens_out) / 10 ** result.token.decimals) === String(first.tokens_out)));
   ck('every buyer has a status and coverage', result.discovered_buyers.every(b => ['core', 'micro_cluster', 'unclustered'].includes(b.status) && typeof b.coverage?.complete === 'boolean'));
   checked = true;
   break;
  }
 }
 ck('sample includes a readable SuiPump launch with a buyer', checked);
 finish();
} finally { server.stop(); }
