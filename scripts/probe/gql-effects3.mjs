const ask=async(q,v)=>(await(await fetch("https://graphql.mainnet.sui.io/graphql",{method:"POST",
  headers:{"content-type":"application/json"},body:JSON.stringify({query:q,variables:v})})).json());
for (const d of ["6rbfmByTyP4k7EREQBV9XZNhaG4RPm2ExT5bhVDfhGpu","CBjycKjVXizZ2VcxVjE2u6xBhP8YJgSgLziZA7N7crXK"]) {
  const r = await ask(`query($d:String!){ transaction(digest:$d){ effects{ status
    executionError{ abortCode sourceLineNumber instructionOffset identifier constant message
      module{ name package{ address } } function{ name } } } } }`, { d });
  console.log(d.slice(0,14)+"…", JSON.stringify(r.data?.transaction?.effects, null, 1).slice(0,420));
}
