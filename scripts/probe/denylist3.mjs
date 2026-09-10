import { SuiGrpcClient } from "@mysten/sui/grpc";
const sui = new SuiGrpcClient({ network:"mainnet", baseUrl:"https://fullnode.mainnet.sui.io" });
const show = async (id, label) => {
  try {
    const r = await sui.listDynamicFields({ parentId: id, limit: 20, cursor: null });
    console.log(`\n${label} ${id.slice(0,14)}… -> ${r.dynamicFields.length} field(s)`);
    for (const df of r.dynamicFields.slice(0,6))
      console.log(`   type=${df.type}  valueType=${df.valueType}  fieldId=${df.fieldId?.slice(0,20)}…`);
    return r.dynamicFields;
  } catch(e){ console.log(label, "ERR", e.message.slice(0,120)); return []; }
};
const top = await show("0x0000000000000000000000000000000000000000000000000000000000000403", "DenyList 0x403");
await show("0xb2345f5fc26fe5044dd03537aaf970a6b9d36f8d84e26a81a4134bd8234aa431", "lists bag");
for (const df of top.slice(0,3)) if (df.fieldId) await show(df.fieldId, "  child");
