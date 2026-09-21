import { MongoClient } from "mongodb";
const m = await MongoClient.connect(process.argv[2]);
const db = m.db();
const sample = await db.collection("messages").findOne({});
console.log("sample keys:", Object.keys(sample ?? {}));
console.log(JSON.stringify(sample).slice(0,600));
const keys = ["tPT9lCrk","LZ7Yqs90","g6zzNh2E","svvVF84y"];
for (const p of keys) {
  const b = await db.collection("bots").findOne({ client_key: new RegExp(`^${p}`) });
  const total = await db.collection("messages").countDocuments({ bot_id: b?._id });
  const paused = await db.collection("messages").countDocuments({ bot_id: b?._id, paused: true });
  const pausedAny = await db.collection("messages").find({ bot_id: b?._id, paused: true }).project({paused:1,ts:1,created:1}).limit(3).toArray();
  console.log(`${b?.name} (${p}): total=${total} paused=true → ${paused}`, pausedAny.map(d=>({paused:d.paused, ts:d.ts||d.created})));
}
await m.close();
