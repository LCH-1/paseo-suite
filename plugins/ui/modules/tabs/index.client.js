import { getPaseoClient } from "@getpaseo/plugin/client";
export default function contribute(client) {
  if (typeof document === "undefined" || typeof globalThis.__r !== "function") return () => {};
  const bundleHash = [...(document.scripts || [])].map(script => script.src.match(/index-([a-f0-9]+)[.]js(?:[?#]|$)/)?.[1]).find(Boolean);
  const preferredMap = [["d18a1505ab14",{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330}],["ddb1ae5c3243",{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330}],["250c5318ac91",{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330}],["e3cdd26bcbc5",{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330}],["dfe881b6f2a1",{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330}],["e6a310062439",{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330}],["e86c48d9b5bf",{"react":37,"rows":5325,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5332,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5331}],["88adff6c3f95",{"react":37,"rows":5346,"presentation":4893,"navigation":3911,"sessions":3660,"layouts":3810,"snapshots":3851,"hostRoutes":3915,"tabGroups":5353,"keyboardActions":4723,"settings":887,"titles":4861,"registry":3681,"newWorkspaceTabs":4473,"tabPresence":5352}],["2f235ca445d0",{"react":37,"rows":5346,"presentation":4893,"navigation":3911,"sessions":3660,"layouts":3810,"snapshots":3851,"hostRoutes":3915,"tabGroups":5353,"keyboardActions":4723,"settings":887,"reopen":5326,"shortcuts":4035,"titles":4861,"registry":3681,"newWorkspaceTabs":4473,"tabPresence":5352}],["46d74b097bb0",{"react":37,"rows":5346,"presentation":4736,"navigation":3911,"sessions":3660,"layouts":3810,"snapshots":3851,"hostRoutes":3915,"tabGroups":5353,"keyboardActions":4573,"settings":887,"reopen":5326,"shortcuts":4035,"titles":4477,"registry":3681,"newWorkspaceTabs":5023,"tabPresence":5352}],["af03a24ed768",{"react":37,"rows":5810,"presentation":5072,"navigation":4243,"sessions":3910,"layouts":4140,"snapshots":4181,"hostRoutes":4247,"tabGroups":5817,"keyboardActions":4909,"settings":890,"reopen":5790,"shortcuts":4369,"titles":4813,"registry":3932,"newWorkspaceTabs":5359,"tabPresence":5816}],["93131b27a095",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["8b6595a0f85f",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["6c180f15d9ac",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["cd1e19f4c2a7",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["e6c2eb90eff7",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["6df05e2755da",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["045b8243f4ed",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["c61fb10ffbce",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["2e8973baadc1",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["d18d083eb2b4",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["dddc9f2c7f5c",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["b7eb1bfd018e",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["e06409b5dbc7",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["c70f2a9e6d6f",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["ad510d4b044f",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["f1070c597404",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["4fe08a1a4b50",{"react":37,"rows":5810,"presentation":5072,"navigation":4243,"sessions":3910,"layouts":4140,"snapshots":4181,"hostRoutes":4247,"tabGroups":5817,"keyboardActions":4909,"settings":890,"reopen":5790,"shortcuts":4369,"titles":4813,"registry":3932,"newWorkspaceTabs":5359,"tabPresence":5816}],["c6d66247a354",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["5b52aab74cf8",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["325d4070ae2d",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["762a0b0cc9fe",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["8713ad945185",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["1a77e5c9f3a8",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["7d8cdccfd09d",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["f728bfb827ce",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["e241eecb6023",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["1318b1c7fd67",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["8ae78bd2e2a4",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["fc5329986dc8",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["fffb735d5ce8",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["4551066ab550",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["2236dd4ab77a",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["35a0596d1967",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["37dc61315d22",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["23904010f446",{"react":37,"rows":5347,"presentation":4740,"navigation":3913,"sessions":3661,"layouts":3812,"snapshots":3853,"hostRoutes":3917,"tabGroups":5353,"keyboardActions":4577,"settings":887,"reopen":5327,"shortcuts":4037,"titles":4481,"registry":3682,"newWorkspaceTabs":5027,"tabPresence":4137}],["1a535b409a4c",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["56b027598f00",{"react":37,"rows":5347,"presentation":4740,"navigation":3913,"sessions":3661,"layouts":3812,"snapshots":3853,"hostRoutes":3917,"tabGroups":5353,"keyboardActions":4577,"settings":887,"reopen":5327,"shortcuts":4037,"titles":4481,"registry":3682,"newWorkspaceTabs":5027,"tabPresence":4137}],["4330d84ec6c9",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["2737a86bae24",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["d9a8d2e52723",{"react":37,"rows":5347,"presentation":4740,"navigation":3913,"sessions":3661,"layouts":3812,"snapshots":3853,"hostRoutes":3917,"tabGroups":5353,"keyboardActions":4576,"settings":887,"reopen":5327,"shortcuts":4037,"titles":4481,"registry":3682,"newWorkspaceTabs":5027,"tabPresence":4137}],["b370bfc32c3e",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["bd6c28576edd",{"react":37,"rows":5347,"presentation":4740,"navigation":3913,"sessions":3661,"layouts":3812,"snapshots":3853,"hostRoutes":3917,"tabGroups":5353,"keyboardActions":4577,"settings":887,"reopen":5327,"shortcuts":4037,"titles":4482,"registry":3682,"newWorkspaceTabs":5027,"tabPresence":4137}],["2039e41bbb8e",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["4a3ad30be780",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["a63f55a14ecd",{"react":37,"rows":5348,"presentation":4741,"navigation":3914,"sessions":3661,"layouts":3770,"snapshots":3853,"hostRoutes":3918,"tabGroups":5354,"keyboardActions":4578,"settings":887,"reopen":5328,"shortcuts":4038,"titles":4483,"registry":3682,"newWorkspaceTabs":5028,"tabPresence":4138}],["4793f7473f32",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["f486f3668039",{"react":37,"rows":5348,"presentation":4741,"navigation":3914,"sessions":3661,"layouts":3770,"snapshots":3853,"hostRoutes":3918,"tabGroups":5354,"keyboardActions":4578,"settings":887,"reopen":5328,"shortcuts":4038,"titles":4483,"registry":3682,"newWorkspaceTabs":5028,"tabPresence":4138}],["1b85efa03ba3",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["2b6f3605ea7f",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["35a3a72fc956",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}],["ec7aa93c3aa8",{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353}]].find(([hash]) => bundleHash?.startsWith(hash))?.[1];
  const candidates = typeof client?.addAgentTabTitleResolver === "function"
    ? [preferredMap, ...[{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5348,"presentation":4741,"navigation":3914,"sessions":3661,"layouts":3770,"snapshots":3853,"hostRoutes":3918,"tabGroups":5354,"keyboardActions":4578,"settings":887,"reopen":5328,"shortcuts":4038,"titles":4483,"registry":3682,"newWorkspaceTabs":5028,"tabPresence":4138},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5348,"presentation":4741,"navigation":3914,"sessions":3661,"layouts":3770,"snapshots":3853,"hostRoutes":3918,"tabGroups":5354,"keyboardActions":4578,"settings":887,"reopen":5328,"shortcuts":4038,"titles":4483,"registry":3682,"newWorkspaceTabs":5028,"tabPresence":4138},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4740,"navigation":3913,"sessions":3661,"layouts":3812,"snapshots":3853,"hostRoutes":3917,"tabGroups":5353,"keyboardActions":4577,"settings":887,"reopen":5327,"shortcuts":4037,"titles":4482,"registry":3682,"newWorkspaceTabs":5027,"tabPresence":4137},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4740,"navigation":3913,"sessions":3661,"layouts":3812,"snapshots":3853,"hostRoutes":3917,"tabGroups":5353,"keyboardActions":4576,"settings":887,"reopen":5327,"shortcuts":4037,"titles":4481,"registry":3682,"newWorkspaceTabs":5027,"tabPresence":4137},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4740,"navigation":3913,"sessions":3661,"layouts":3812,"snapshots":3853,"hostRoutes":3917,"tabGroups":5353,"keyboardActions":4577,"settings":887,"reopen":5327,"shortcuts":4037,"titles":4481,"registry":3682,"newWorkspaceTabs":5027,"tabPresence":4137},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4740,"navigation":3913,"sessions":3661,"layouts":3812,"snapshots":3853,"hostRoutes":3917,"tabGroups":5353,"keyboardActions":4577,"settings":887,"reopen":5327,"shortcuts":4037,"titles":4481,"registry":3682,"newWorkspaceTabs":5027,"tabPresence":4137},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5810,"presentation":5072,"navigation":4243,"sessions":3910,"layouts":4140,"snapshots":4181,"hostRoutes":4247,"tabGroups":5817,"keyboardActions":4909,"settings":890,"reopen":5790,"shortcuts":4369,"titles":4813,"registry":3932,"newWorkspaceTabs":5359,"tabPresence":5816},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5347,"presentation":4737,"navigation":3912,"sessions":3661,"layouts":3811,"snapshots":3852,"hostRoutes":3916,"tabGroups":5354,"keyboardActions":4574,"settings":887,"reopen":5327,"shortcuts":4036,"titles":4478,"registry":3682,"newWorkspaceTabs":5024,"tabPresence":5353},{"react":37,"rows":5810,"presentation":5072,"navigation":4243,"sessions":3910,"layouts":4140,"snapshots":4181,"hostRoutes":4247,"tabGroups":5817,"keyboardActions":4909,"settings":890,"reopen":5790,"shortcuts":4369,"titles":4813,"registry":3932,"newWorkspaceTabs":5359,"tabPresence":5816},{"react":37,"rows":5346,"presentation":4736,"navigation":3911,"sessions":3660,"layouts":3810,"snapshots":3851,"hostRoutes":3915,"tabGroups":5353,"keyboardActions":4573,"settings":887,"reopen":5326,"shortcuts":4035,"titles":4477,"registry":3681,"newWorkspaceTabs":5023,"tabPresence":5352},{"react":37,"rows":5346,"presentation":4893,"navigation":3911,"sessions":3660,"layouts":3810,"snapshots":3851,"hostRoutes":3915,"tabGroups":5353,"keyboardActions":4723,"settings":887,"reopen":5326,"shortcuts":4035,"titles":4861,"registry":3681,"newWorkspaceTabs":4473,"tabPresence":5352},{"react":37,"rows":5346,"presentation":4893,"navigation":3911,"sessions":3660,"layouts":3810,"snapshots":3851,"hostRoutes":3915,"tabGroups":5353,"keyboardActions":4723,"settings":887,"titles":4861,"registry":3681,"newWorkspaceTabs":4473,"tabPresence":5352},{"react":37,"rows":5325,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5332,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5331},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5324,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5331,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5330},{"react":37,"rows":5321,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5328,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5327},{"react":37,"rows":5319,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5326,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5325},{"react":37,"rows":5318,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5325,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5324},{"react":37,"rows":5316,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5323,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5322},{"react":37,"rows":5316,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"tabGroups":5323,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5322},{"react":37,"rows":5316,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5453},{"react":37,"rows":5317,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5454},{"react":37,"rows":5315,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5452},{"react":37,"rows":5315,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453,"tabPresence":5452},{"react":37,"rows":5316,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453},{"react":37,"rows":5315,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453},{"react":37,"rows":5316,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453},{"react":37,"rows":5314,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453},{"react":37,"rows":5313,"presentation":4873,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4703,"settings":887,"titles":4841,"registry":3681,"newWorkspaceTabs":4453},{"react":37,"rows":5312,"presentation":4872,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"keyboardActions":4702,"settings":887,"titles":4840,"registry":3681,"newWorkspaceTabs":4452},{"react":37,"rows":5311,"presentation":4871,"navigation":3891,"sessions":3660,"layouts":3791,"snapshots":3832,"hostRoutes":3895,"titles":4839,"registry":3681,"newWorkspaceTabs":4449,"keyboardActions":4701,"settings":887},{"react":37,"rows":5309,"presentation":4869,"navigation":3890,"sessions":3659,"layouts":3790,"snapshots":3831,"hostRoutes":3894,"titles":4837,"registry":3680,"newWorkspaceTabs":4447,"keyboardActions":4699,"settings":887},{"react":37,"rows":5307,"presentation":4696,"navigation":3890,"sessions":3659,"layouts":3790,"snapshots":3831,"hostRoutes":3894,"titles":4978,"registry":3680,"keyboardActions":4541,"settings":887},{"react":37,"rows":5307,"presentation":4696,"navigation":3890,"sessions":3659,"layouts":3790,"snapshots":3831,"hostRoutes":3894,"titles":4978,"registry":3680,"keyboardActions":4541,"settings":887}]].filter(Boolean)
    : [{"react":37,"rows":5324,"presentation":4715,"navigation":3909,"sessions":3659,"layouts":3809,"snapshots":3850,"hostRoutes":3913,"keyboardActions":4559,"settings":887}];
  let ids, modules;
  for (const candidate of candidates) {
    let loaded;
    try {
      loaded = Object.fromEntries(Object.entries(candidate).map(([name, id]) => [name, globalThis.__r(id)]));
    } catch { continue; }
    const valid = typeof loaded.react?.createElement === "function"
      && typeof loaded.react?.useState === "function"
      && typeof loaded.react?.useEffect === "function"
      && typeof loaded.react?.useSyncExternalStore === "function"
      && typeof loaded.rows?.WorkspaceDesktopTabsRow === "function"
      && typeof loaded.presentation?.WorkspaceTabPresentationResolver === "function"
      && typeof loaded.navigation?.navigateToWorkspace === "function"
      && typeof loaded.navigation?.useLastWorkspaceSelection === "function"
      && typeof loaded.navigation?.getLastWorkspaceSelection === "function"
      && typeof loaded.hostRoutes?.parseHostWorkspaceRouteFromPathname === "function"
      && typeof loaded.keyboardActions?.useKeyboardActionHandler === "function"
      && (!candidate.settings || typeof loaded.settings?.useSettings === "function")
      && (!candidate.titles || ["selectAgentTabSidebarLabel", "selectAgentTabProjectLabel"]
        .every((name) => typeof loaded.titles?.[name] === "function"))
      && (!candidate.tabGroups || (typeof loaded.tabGroups?.isTabGroupKeyVisible === "function"
        && typeof loaded.tabGroups?.forgetTabGroupKey === "function"
        && typeof loaded.tabGroups?.useTabGroups === "function"
        && typeof loaded.tabGroups?.useTabGroups?.getState === "function"
        && typeof loaded.tabGroups?.useTabGroups?.subscribe === "function"
        && typeof loaded.tabGroups?.useTabGroups?.getState()?.update === "function"))
      && typeof loaded.sessions?.useSessionStore === "function"
      && typeof loaded.sessions?.useSessionStore?.getState === "function"
      && typeof loaded.sessions?.useSessionStore?.subscribe === "function"
      && typeof loaded.sessions?.useSessionStore?.getState()?.setAgentDetails === "function"
      && typeof loaded.snapshots?.normalizeAgentSnapshot === "function"
      && typeof loaded.layouts?.useWorkspaceLayoutStore?.getState === "function"
      && typeof loaded.layouts?.useWorkspaceLayoutStore?.setState === "function"
      && (!candidate.reopen || typeof loaded.reopen?.reopenLastClosedWorkspaceTab === "function")
      && (!candidate.tabPresence || ["read", "getSnapshot", "subscribe", "register"]
        .every((name) => typeof loaded.tabPresence?.agentTabPresenceBridge?.[name] === "function"))
      && (!candidate.newWorkspaceTabs || ["getSnapshot", "subscribe", "registerTabBar", "open", "activate", "close"]
        .every((name) => typeof loaded.newWorkspaceTabs?.newWorkspaceTabsBridge?.[name] === "function"));
    if (valid) { ids = candidate; modules = loaded; break; }
  }
  if (!modules) throw new Error("Global Workspace Tabs: unsupported Paseo module exports");
  const leaseKey = "__PASEO_GLOBAL_TABS_LEASE__";
  const revision = "385f510315ea4a4f200157dd2f910e33666f306d2193f28700939fbaf4432244";
  let lease = globalThis[leaseKey];
  function retain(current) {
    const owner = Symbol();
    current.owners.add(owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      current.owners.delete(owner);
      if (current.owners.size > 0) return;
      current.controller.dispose();
      if (globalThis[leaseKey] === current) delete globalThis[leaseKey];
    };
  }
  if (lease?.revision === revision && lease.controller === globalThis.__PASEO_GLOBAL_TABS__) return retain(lease);
  const previousDraftPins = [...(globalThis.__PASEO_GLOBAL_TABS__?.pinnedDrafts || [])];
  globalThis.__PASEO_GLOBAL_TABS__?.dispose();
  globalThis.__PASEO_GLOBAL_TABS_MODULES__ = ids;
  globalThis.PaseoGlobalTabsModel = (function () {
  "use strict";
  const STORAGE_KEY = "paseo-global-workspace-tabs:v1";
  const SHARED_PREFIX = STORAGE_KEY + ":shared:";
  const isLifecycleKey = (key) =>
    key.startsWith(SHARED_PREFIX + "archive:") ||
    key.startsWith(SHARED_PREFIX + "deleted:");
  const agentKey = (serverId, agentId) => JSON.stringify([serverId, agentId]);
  function keyOf(serverId, workspaceId, tabId) {
    return JSON.stringify([serverId, workspaceId, tabId]);
  }
  function windowStorageKey(key, scope) {
    if (!scope || isLifecycleKey(key)) return key;
    return "paseo-project-window:" + scope.windowId + ":" + key;
  }
  function windowStorage(storage, scope) {
    const prefix = scope ? "paseo-project-window:" + scope.windowId + ":" : "";
    function keys() {
      const result = [];
      if (typeof storage?.key !== "function") return result;
      const length = storage.length;
      for (let index = 0; index < length; index++) {
        const key = storage.key(index);
        if (!scope) result.push(key);
        else if (key?.startsWith(prefix + STORAGE_KEY))
          result.push(key.slice(prefix.length));
        else if (key && isLifecycleKey(key)) result.push(key);
      }
      return result;
    }
    return {
      getItem: (key) => storage.getItem(windowStorageKey(key, scope)),
      setItem: (key, value) =>
        storage.setItem(windowStorageKey(key, scope), value),
      keys,
    };
  }
  function isWindowStorageEvent(key, scope) {
    if (key === null) return true;
    if (isLifecycleKey(key)) return true;
    return key.startsWith(windowStorageKey(STORAGE_KEY, scope));
  }
  function createModel(storage, getSessionMap, scope = null) {
    storage = windowStorage(storage, scope);
    function accepts(serverId, workspaceId, allowUnresolved = false) {
      if (!scope) return true;
      if (scope.serverId !== serverId) return false;
      const workspace =
        getSessionMap?.()?.[serverId]?.workspaces?.get(workspaceId);
      return workspace
        ? workspace.projectId === scope.projectId
        : allowUnresolved;
    }
    let storageFailed = false;
    let saved;
    try {
      saved = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
    } catch {
      saved = null;
      storageFailed = true;
    }
    const valid = (item) =>
      item &&
      typeof item.serverId === "string" &&
      typeof item.workspaceId === "string" &&
      typeof item.tabId === "string" &&
      typeof item.agentId === "string" &&
      accepts(item.serverId, item.workspaceId, true);
    let entries = Array.isArray(saved?.entries)
      ? saved.entries
          .filter(valid)
          .filter((item) => saved.schemaVersion !== 2 || item.pinned === true)
          .map((item) => ({
            ...item,
            pinned: true,
            key: keyOf(item.serverId, item.workspaceId, item.tabId),
          }))
      : [];
    const dismissed = new Set(
      Array.isArray(saved?.dismissed)
        ? saved.dismissed.filter((id) => typeof id === "string")
        : [],
    );
    entries = [
      ...new Map(
        entries.map((item) => [
          keyOf(item.serverId, item.workspaceId, item.tabId),
          item,
        ]),
      ).values(),
    ];
    let active = null;
    let dismissedActive = null;
    let revision = 0;
    const listeners = new Set();
    const ownership = new Map();
    const ownershipVersions = new Map();
    const observedVersions = new Map();
    const placementChanges = new Set();
    const sharedOwnership = new Map();
    let observedSessions = {};
    function snapshotsFor(entry) {
      const session = (getSessionMap ? getSessionMap() : observedSessions)?.[
        entry.serverId
      ];
      return [
        session?.agents?.get(entry.agentId),
        session?.agentDetails?.get(entry.agentId),
      ].filter(Boolean);
    }
    function snapshotVersion(snapshot) {
      const value = snapshot.updatedAt;
      const version = value == null ? NaN : Number(new Date(value));
      return Number.isFinite(version) ? version : null;
    }
    const closedAt = new Map(
      Array.isArray(saved?.closedAt)
        ? saved.closedAt.filter(
            (item) =>
              Array.isArray(item) &&
              typeof item[0] === "string" &&
              Number.isFinite(item[1]),
          )
        : [],
    );
    let openAgents = new Set(
      entries.map((entry) => agentKey(entry.serverId, entry.agentId)),
    );
    const known = new Set([...openAgents, ...closedAt.keys()]);
    const pendingWrites = new Map();
    const identity = (entry) => agentKey(entry.serverId, entry.agentId);
    let prunedArchived = false;
    function read(key) {
      try {
        return pendingWrites.has(key)
          ? pendingWrites.get(key)
          : JSON.parse(storage.getItem(key) || "null");
      } catch {
        storageFailed = true;
        return null;
      }
    }
    function write(key, value) {
      try {
        const serialized = JSON.stringify(value);
        if (storage.getItem(key) !== serialized)
          storage.setItem(key, serialized);
        pendingWrites.delete(key);
      } catch {
        storageFailed = true;
        pendingWrites.set(key, value);
      }
    }
    // Keep archive state separate from tab presence so a stale window cannot
    // reopen a conversation another window has archived.
    function archiveState(entry) {
      if (read(SHARED_PREFIX + "deleted:" + identity(entry))?.deleted === true)
        return true;
      const key = SHARED_PREFIX + "archive:" + identity(entry);
      let record = read(key);
      const snapshots = snapshotsFor(entry).filter(
        (snapshot) =>
          (!snapshot.id || snapshot.id === entry.agentId) &&
          Object.hasOwn(snapshot, "archivedAt"),
      );
      const latest = snapshots.reduce((previous, snapshot) => {
        const version = snapshotVersion(snapshot) ?? -Infinity;
        const previousVersion = previous
          ? (snapshotVersion(previous) ?? -Infinity)
          : -Infinity;
        return !previous ||
          version > previousVersion ||
          (version === previousVersion && snapshot.archivedAt)
          ? snapshot
          : previous;
      }, null);
      if (latest) {
        const version = snapshotVersion(latest);
        const archived = Boolean(latest.archivedAt);
        const newer =
          !record ||
          (version !== null &&
            (record.observedAt === null || version > record.observedAt));
        const equalArchive =
          archived && version === record?.observedAt && !record?.archived;
        if ((newer || equalArchive) && (archived || record)) {
          record = { archived, observedAt: version };
          write(key, record);
        }
      }
      return record?.archived === true;
    }
    function removeArchived(next) {
      return next.filter((entry) => {
        if (!archiveState(entry)) return true;
        const key = identity(entry);
        const presenceKey = SHARED_PREFIX + "presence:" + key;
        const presence = read(presenceKey);
        const lastClosedAt =
          Math.max(closedAt.get(key) ?? 0, presence?.lastClosedAt ?? 0) ||
          Date.now();
        closedAt.set(key, lastClosedAt);
        dismissed.add(entry.key);
        if (active === key) dismissedActive = key;
        if (presence?.entry) write(presenceKey, { entry: null, lastClosedAt });
        prunedArchived = true;
        return false;
      });
    }
    function trackedAgents() {
      return [...known].flatMap((key) => {
        let parts;
        try {
          parts = JSON.parse(key);
        } catch {
          return [];
        }
        return Array.isArray(parts) &&
          parts.length === 2 &&
          parts.every((part) => typeof part === "string")
          ? [{ serverId: parts[0], agentId: parts[1] }]
          : [];
      });
    }
    function records() {
      try {
        for (const key of storage.keys()) {
          if (key?.startsWith(SHARED_PREFIX + "presence:"))
            known.add(key.slice((SHARED_PREFIX + "presence:").length));
        }
      } catch {
        storageFailed = true;
      }
      return [...known].map((key) => [
        key,
        read(SHARED_PREFIX + "presence:" + key),
      ]);
    }
    if (!read(SHARED_PREFIX + "initialized")) {
      for (const entry of entries) {
        const key = identity(entry);
        if (!read(SHARED_PREFIX + "presence:" + key))
          write(SHARED_PREFIX + "presence:" + key, {
            entry,
            lastClosedAt: closedAt.get(key) ?? null,
          });
      }
      for (const [key, time] of closedAt) {
        if (!read(SHARED_PREFIX + "presence:" + key))
          write(SHARED_PREFIX + "presence:" + key, {
            entry: null,
            lastClosedAt: time,
          });
      }
      write(
        SHARED_PREFIX + "order",
        entries.filter((entry) => entry.pinned).map(identity),
      );
      write(SHARED_PREFIX + "initialized", true);
    }
    function merge() {
      const local = new Map(entries.map((entry) => [identity(entry), entry]));
      const shared = new Map();
      const found = new Set();
      for (const [key, record] of records()) {
        if (!record) continue;
        found.add(key);
        if (Number.isFinite(record.lastClosedAt))
          closedAt.set(
            key,
            Math.max(closedAt.get(key) ?? 0, record.lastClosedAt),
          );
        if (record.entry && valid(record.entry)) {
          let placement = read(SHARED_PREFIX + "placement:" + key);
          const incomingVersion = Number.isFinite(placement?.observedAt)
            ? placement.observedAt
            : null;
          const adoptedVersion = ownershipVersions.get(key);
          const previousEntry = local.get(key);
          if (
            incomingVersion !== null &&
            adoptedVersion !== undefined &&
            adoptedVersion > incomingVersion &&
            previousEntry
          ) {
            placement = {
              workspaceId: previousEntry.workspaceId,
              tabId: previousEntry.tabId,
              observedAt: adoptedVersion,
            };
            write(SHARED_PREFIX + "placement:" + key, placement);
          }
          const title = read(SHARED_PREFIX + "title:" + key);
          const entry = {
            ...record.entry,
            ...(placement
              ? { workspaceId: placement.workspaceId, tabId: placement.tabId }
              : {}),
            ...(title ? { title } : {}),
            pinned: true,
          };
          entry.key = keyOf(entry.serverId, entry.workspaceId, entry.tabId);
          const observedAt = Number.isFinite(placement?.observedAt)
            ? placement.observedAt
            : null;
          const guard = sharedOwnership.get(key);
          if (
            guard?.workspaceId !== entry.workspaceId ||
            guard.observedAt !== observedAt
          ) {
            sharedOwnership.set(key, {
              workspaceId: entry.workspaceId,
              observedAt,
              blocked: snapshotsFor(entry)
                .filter(
                  (snapshot) => snapshot.workspaceId !== entry.workspaceId,
                )
                .map((snapshot) => ({
                  workspaceId: snapshot.workspaceId,
                  observedAt: snapshotVersion(snapshot),
                })),
            });
          }
          ownership.set(key, entry.workspaceId);
          if (observedAt === null) ownershipVersions.delete(key);
          else {
            ownershipVersions.set(key, observedAt);
            observedVersions.set(
              key,
              Math.max(observedVersions.get(key) ?? -Infinity, observedAt),
            );
          }
          shared.set(key, entry);
          dismissed.delete(entry.key);
          if (dismissedActive === key) dismissedActive = null;
        } else if (local.get(key)?.pinned) {
          dismissed.add(local.get(key).key);
          if (active === key) dismissedActive = key;
        }
      }
      const order = read(SHARED_PREFIX + "order");
      const keys = [
        ...new Set([
          ...(Array.isArray(order) ? order : []),
          ...entries.map(identity),
          ...shared.keys(),
        ]),
      ];
      entries = removeArchived(
        keys.flatMap((key) =>
          shared.has(key)
            ? [shared.get(key)]
            : local.has(key) && (!local.get(key).pinned || !found.has(key))
              ? [local.get(key)]
              : [],
        ),
      );
      openAgents = new Set(entries.map(identity));
    }
    merge();
    let previous = entries;
    function persist() {
      write(STORAGE_KEY, {
        schemaVersion: 2,
        entries: entries.filter((entry) => entry.pinned),
        dismissed: [...dismissed],
        closedAt: [...closedAt],
      });
    }
    function notify(
      reordered = false,
      explicitlyClosed = null,
      explicitlyOpened = null,
    ) {
      const nextOpenAgents = new Set(
        entries.map((entry) => agentKey(entry.serverId, entry.agentId)),
      );
      const now = Date.now();
      for (const key of openAgents)
        if (!nextOpenAgents.has(key)) closedAt.set(key, now);
      const before = new Map(previous.map((entry) => [identity(entry), entry]));
      const after = new Map(entries.map((entry) => [identity(entry), entry]));
      for (const [key, entry] of after) {
        known.add(key);
        const old = before.get(key);
        if (entry.pinned && (!old?.pinned || explicitlyOpened === key)) {
          const shared = read(SHARED_PREFIX + "presence:" + key);
          const lastClosedAt =
            Math.max(closedAt.get(key) ?? 0, shared?.lastClosedAt ?? 0) || null;
          if (lastClosedAt !== null) closedAt.set(key, lastClosedAt);
          write(SHARED_PREFIX + "presence:" + key, { entry, lastClosedAt });
        }
        if (
          entry.pinned &&
          (!old || entry.key !== old.key || placementChanges.has(key))
        )
          write(SHARED_PREFIX + "placement:" + key, {
            workspaceId: entry.workspaceId,
            tabId: entry.tabId,
            observedAt: ownershipVersions.get(key) ?? null,
          });
        if (entry.pinned && entry.title && entry.title !== old?.title)
          write(SHARED_PREFIX + "title:" + key, entry.title);
      }
      for (const [key, entry] of before) {
        if (after.has(key)) continue;
        known.add(key);
        const shared = read(SHARED_PREFIX + "presence:" + key);
        if (entry.pinned || explicitlyClosed === key || !shared?.entry)
          write(SHARED_PREFIX + "presence:" + key, {
            entry: null,
            lastClosedAt: closedAt.get(key) ?? now,
          });
      }
      if (reordered) write(SHARED_PREFIX + "order", entries.map(identity));
      placementChanges.clear();
      merge();
      previous = entries;
      revision++;
      persist();
      listeners.forEach((listener) => listener());
    }
    if (saved && (saved.schemaVersion !== 2 || prunedArchived)) persist();
    return {
      entries: () => entries,
      isArchived: (serverId, agentId) => archiveState({ serverId, agentId }),
      tabPresence(serverId, agentId) {
        const key = agentKey(serverId, agentId);
        return {
          isOpen: openAgents.has(key),
          lastClosedAt: closedAt.get(key) ?? null,
        };
      },
      preview: () => entries.find((entry) => !entry.pinned) || null,
      isPinned: (key) =>
        Boolean(entries.find((entry) => entry.key === key)?.pinned),
      pin(key) {
        const entry = entries.find((entry) => entry.key === key);
        if (entry && archiveState(entry)) {
          entries = removeArchived(entries);
          notify();
          return false;
        }
        if (!entry || entry.pinned) return false;
        entries = entries.map((item) =>
          item === entry ? { ...item, pinned: true } : item,
        );
        notify(true);
        return true;
      },
      revision: () => revision,
      storageStatus: () => ({
        state: storageFailed ? "memory-only" : "ready",
        pendingWrites: pendingWrites.size,
        message: storageFailed
          ? "탭 저장소에 접근하지 못했습니다. 현재 창의 탭은 유지하지만 저장과 다른 창의 동기화를 확인할 수 없습니다."
          : null,
      }),
      synchronize() {
        const before = JSON.stringify([entries, [...closedAt]]);
        merge();
        previous = entries;
        if (before === JSON.stringify([entries, [...closedAt]])) return;
        revision++;
        persist();
        listeners.forEach((listener) => listener());
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retainAt(serverId, workspaceId, tab, index = entries.length) {
        if (!accepts(serverId, workspaceId)) return null;
        if (
          ![serverId, workspaceId, tab?.tabId, tab?.target?.agentId].every(
            (value) => typeof value === "string" && value.length,
          ) ||
          tab.target.kind !== "agent"
        )
          return null;
        const identity = agentKey(serverId, tab.target.agentId);
        if (archiveState({ serverId, agentId: tab.target.agentId })) {
          const next = removeArchived(entries);
          if (next.length !== entries.length) {
            entries = next;
            notify();
          }
          return null;
        }
        const previous = entries.find(
          (entry) => agentKey(entry.serverId, entry.agentId) === identity,
        );
        const key = keyOf(serverId, workspaceId, tab.tabId);
        const entry = {
          ...previous,
          key,
          serverId,
          workspaceId,
          tabId: tab.tabId,
          agentId: tab.target.agentId,
          pinned: true,
        };
        const next = entries.filter(
          (item) => agentKey(item.serverId, item.agentId) !== identity,
        );
        next.splice(
          Math.max(
            0,
            Math.min(
              Number.isFinite(index) ? Math.trunc(index) : next.length,
              next.length,
            ),
          ),
          0,
          entry,
        );
        ownership.set(identity, workspaceId);
        if (previous?.workspaceId !== workspaceId) {
          const versions = snapshotsFor(entry)
            .filter((snapshot) => snapshot.workspaceId === workspaceId)
            .map(snapshotVersion)
            .filter((version) => version !== null);
          if (versions.length) {
            ownershipVersions.set(identity, Math.max(...versions));
            observedVersions.set(
              identity,
              Math.max(
                observedVersions.get(identity) ?? -Infinity,
                ...versions,
              ),
            );
          } else ownershipVersions.delete(identity);
        }
        dismissed.delete(key);
        if (dismissedActive === identity) dismissedActive = null;
        if (
          next.length === entries.length &&
          next.every(
            (item, position) =>
              item.key === entries[position].key &&
              item.pinned === entries[position].pinned,
          ) &&
          read(SHARED_PREFIX + "presence:" + identity)?.entry
        )
          return entries.find((item) => item.key === key);
        entries = next;
        notify(true, null, identity);
        return entry;
      },
      reconcile(sessionMap) {
        if (!getSessionMap)
          observedSessions = Object.fromEntries(
            Object.entries(sessionMap || {}).map(([id, session]) => [
              id,
              { agents: session?.agents, agentDetails: session?.agentDetails },
            ]),
          );
        for (const entry of trackedAgents())
          if (!openAgents.has(identity(entry))) archiveState(entry);
        let changed = false;
        const seen = new Map();
        const next = [];
        for (const entry of entries) {
          if (
            archiveState(entry) ||
            !accepts(entry.serverId, entry.workspaceId, true)
          ) {
            changed = true;
            continue;
          }
          const session = sessionMap?.[entry.serverId];
          const candidates = [
            session?.agents?.get(entry.agentId),
            session?.agentDetails?.get(entry.agentId),
          ];
          const identity = agentKey(entry.serverId, entry.agentId);
          const guard = sharedOwnership.get(identity);
          const watermark = observedVersions.get(identity);
          const usable = candidates.filter((item) => {
            if (
              !item ||
              (item.id && item.id !== entry.agentId) ||
              typeof item.workspaceId !== "string" ||
              !item.workspaceId.length
            )
              return false;
            const version = snapshotVersion(item);
            if (
              watermark !== undefined &&
              (version === null ||
                version < watermark ||
                (version === watermark &&
                  item.workspaceId !== entry.workspaceId))
            )
              return false;
            if (!guard || item.workspaceId === guard.workspaceId) return true;
            if (guard.observedAt !== null)
              return version !== null && version > guard.observedAt;
            return !guard.blocked.some(
              (blocked) =>
                blocked.workspaceId === item.workspaceId &&
                (version === null ||
                  (blocked.observedAt !== null &&
                    version <= blocked.observedAt)),
            );
          });
          const agent = usable.reduce(
            (latest, item) =>
              !latest ||
              (snapshotVersion(item) ?? -Infinity) >
                (snapshotVersion(latest) ?? -Infinity)
                ? item
                : latest,
            null,
          );
          if (agent) {
            ownership.set(identity, agent.workspaceId);
            const observedAt = snapshotVersion(agent);
            if (
              observedAt !== null &&
              (ownershipVersions.get(identity) !== observedAt ||
                agent.workspaceId !== entry.workspaceId)
            ) {
              ownershipVersions.set(identity, observedAt);
              observedVersions.set(
                identity,
                Math.max(
                  observedVersions.get(identity) ?? -Infinity,
                  observedAt,
                ),
              );
              placementChanges.add(identity);
              changed = true;
            }
          }
          const workspaceId = ownership.get(identity);
          if (!workspaceId) {
            next.push(entry);
            continue;
          }
          let updated = entry;
          if (workspaceId !== entry.workspaceId) {
            updated = {
              ...entry,
              workspaceId,
              key: keyOf(entry.serverId, workspaceId, entry.tabId),
            };
            if (dismissed.delete(entry.key)) dismissed.add(updated.key);
            changed = true;
          }
          const previous = seen.get(identity);
          if (previous !== undefined) {
            if (updated.pinned && !next[previous].pinned)
              next[previous] = { ...next[previous], pinned: true };
            changed = true;
            continue;
          }
          seen.set(identity, next.length);
          if (accepts(updated.serverId, updated.workspaceId, true))
            next.push(updated);
          else changed = true;
        }
        if (changed) {
          entries = next;
          notify();
        }
      },
      rememberTitle(serverId, agentId, title) {
        if (typeof title !== "string" || !title.trim()) return;
        let changed = false;
        entries = entries.map((entry) => {
          if (
            entry.serverId !== serverId ||
            entry.agentId !== agentId ||
            entry.title === title
          )
            return entry;
          changed = true;
          return { ...entry, title };
        });
        if (changed) notify();
      },
      ingest(serverId, workspaceId, rows) {
        if (!accepts(serverId, workspaceId)) return;
        const next = removeArchived(entries);
        let changed = next.length !== entries.length;
        entries = next;
        const selected = rows.find(
          (row) =>
            row.isActive &&
            row.tab.target.kind === "agent" &&
            !archiveState({ serverId, agentId: row.tab.target.agentId }),
        );
        if (selected)
          workspaceId =
            ownership.get(agentKey(serverId, selected.tab.target.agentId)) ||
            workspaceId;
        const selectedKey = selected
          ? keyOf(serverId, workspaceId, selected.tab.tabId)
          : null;
        const selectedIdentity = selected
          ? agentKey(serverId, selected.tab.target.agentId)
          : null;
        if (selectedIdentity !== active) {
          active = selectedIdentity;
          dismissedActive = null;
          if (selectedKey && dismissed.delete(selectedKey)) changed = true;
        }
        if (
          selected &&
          selectedIdentity !== dismissedActive &&
          !dismissed.has(selectedKey) &&
          !entries.some(
            (item) =>
              item.serverId === serverId &&
              item.agentId === selected.tab.target.agentId,
          )
        ) {
          const entry = {
            key: selectedKey,
            serverId,
            workspaceId,
            tabId: selected.tab.tabId,
            agentId: selected.tab.target.agentId,
            pinned: false,
          };
          const previewIndex = entries.findIndex((item) => !item.pinned);
          entries =
            previewIndex < 0
              ? [...entries, entry]
              : entries.map((item, index) =>
                  index === previewIndex ? entry : item,
                );
          changed = true;
        }
        if (changed) notify();
      },
      close(key) {
        const entry = entries.find((item) => item.key === key);
        if (entry && agentKey(entry.serverId, entry.agentId) === active)
          dismissedActive = active;
        dismissed.add(key);
        entries = entries.filter((item) => item.key !== key);
        notify(false, entry ? identity(entry) : null);
      },
      forgetAgent(serverId, agentId) {
        const key = agentKey(serverId, agentId);
        write(SHARED_PREFIX + "deleted:" + key, { deleted: true });
        for (const entry of entries.filter((entry) => identity(entry) === key))
          dismissed.add(entry.key);
        if (active === key) dismissedActive = active;
        entries = entries.filter((entry) => identity(entry) !== key);
        notify();
      },
      closeWorkspace(serverId, workspaceId) {
        const closing = entries.filter(
          (entry) =>
            entry.serverId === serverId && entry.workspaceId === workspaceId,
        );
        const affected = new Map(
          closing.map((entry) => [identity(entry), entry]),
        );
        for (const entry of trackedAgents()) {
          if (
            entry.serverId === serverId &&
            (ownership.get(identity(entry)) === workspaceId ||
              snapshotsFor(entry).some(
                (snapshot) => snapshot.workspaceId === workspaceId,
              ))
          )
            affected.set(identity(entry), entry);
        }
        for (const entry of affected.values()) {
          const versions = snapshotsFor(entry)
            .map(snapshotVersion)
            .filter((version) => version !== null);
          write(SHARED_PREFIX + "archive:" + identity(entry), {
            archived: true,
            observedAt: versions.length ? Math.max(...versions) : null,
          });
        }
        if (!closing.length) return;
        for (const entry of closing) {
          dismissed.add(entry.key);
          if (identity(entry) === active) dismissedActive = active;
        }
        entries = entries.filter(
          (entry) =>
            entry.serverId !== serverId || entry.workspaceId !== workspaceId,
        );
        notify();
      },
      reorder(keys) {
        const rank = new Map(keys.map((key, index) => [key, index]));
        entries = [...entries].sort(
          (a, b) =>
            (rank.get(a.key) ?? keys.length) - (rank.get(b.key) ?? keys.length),
        );
        notify(true);
      },
      keyOf,
    };
  }
  return {
    createModel,
    keyOf,
    STORAGE_KEY,
    SHARED_PREFIX,
    windowStorageKey,
    isWindowStorageEvent,
  };
})();
  globalThis.PaseoGlobalTabsMetadata = (function () {
  "use strict";
  const keyOf = (entry) => JSON.stringify([entry.serverId, entry.agentId]);
  function createLoader({
    model,
    sessions,
    getPaseoClient,
    normalizeAgentSnapshot,
  }) {
    let stopped = false;
    let queued = false;
    let running = 0;
    let revision = 0;
    const listeners = new Set();
    const attempts = new Map();
    const connections = new Map();
    const releases = [];
    let sessionMetadata = new Map();
    function onSessionsChanged() {
      const current = sessions.getState().sessions;
      const ids = Object.keys(current);
      const values = ids.map((id) => {
        const session = current[id];
        return [
          session.client,
          session.clientGeneration,
          session.client?.isConnected,
          session.agents,
          session.agentDetails,
          session.workspaces,
        ];
      });
      if (
        ids.length === sessionMetadata.size &&
        ids.every((id, index) => {
          const previous = sessionMetadata.get(id);
          return (
            previous &&
            values[index].every((value, field) => value === previous[field])
          );
        })
      )
        return;
      for (const [index, id] of ids.entries()) {
        const previous = sessionMetadata.get(id);
        if (
          !previous ||
          values[index]
            .slice(0, 3)
            .some((value, field) => value !== previous[field])
        )
          connections.set(id, Symbol());
      }
      for (const id of connections.keys())
        if (!Object.hasOwn(current, id)) connections.delete(id);
      sessionMetadata = new Map(ids.map((id, index) => [id, values[index]]));
      if (pruneAttempts()) notify();
      schedule();
    }
    function notify() {
      revision++;
      listeners.forEach((listener) => listener());
    }
    function sessionFor(entry) {
      return sessions.getState().sessions[entry.serverId];
    }
    function cached(entry) {
      const session = sessionFor(entry);
      return (
        session?.agents.get(entry.agentId) ??
        session?.agentDetails.get(entry.agentId)
      );
    }
    function sameConnection(entry, attempt) {
      const session = sessionFor(entry);
      return (
        session?.client === attempt.client &&
        session?.clientGeneration === attempt.generation &&
        session?.client?.isConnected !== false &&
        connections.get(entry.serverId) === attempt.connection
      );
    }
    function pruneAttempts(entries = model.entries()) {
      if (!attempts.size) return false;
      const retained = new Map(entries.map((entry) => [keyOf(entry), entry]));
      let changed = false;
      for (const [key, attempt] of attempts) {
        const entry = retained.get(key);
        if (!entry || cached(entry) || !sameConnection(entry, attempt)) {
          attempts.delete(key);
          changed = true;
        }
      }
      return changed;
    }
    function currentAttempt(entry, attempt) {
      return (
        attempts.get(keyOf(entry)) === attempt &&
        sameConnection(entry, attempt) &&
        model.entries().some((item) => keyOf(item) === keyOf(entry))
      );
    }
    function onModelChanged() {
      if (pruneAttempts()) notify();
      schedule();
    }
    function state(entry) {
      const agent = cached(entry);
      if (agent) return { tag: "ready", title: agent.title };
      const attempt = attempts.get(keyOf(entry));
      if (attempt && sameConnection(entry, attempt)) return attempt;
      return { tag: "waiting" };
    }
    function schedule() {
      if (stopped || queued) return;
      queued = true;
      Promise.resolve().then(() => {
        queued = false;
        pump();
      });
    }
    async function fetch(entry, attempt) {
      try {
        const result = await getPaseoClient(entry.serverId)
          .agents.ref(entry.agentId)
          .refresh();
        if (stopped || !currentAttempt(entry, attempt)) return;
        if (!result) {
          attempt.tag = "missing";
          return;
        }
        if (result.agent.id !== entry.agentId) {
          attempt.tag = "mismatch";
          return;
        }
        const agent = {
          ...normalizeAgentSnapshot(result.agent, entry.serverId),
          projectPlacement: result.project,
        };
        if (!cached(entry)) {
          sessions.getState().setAgentDetails(entry.serverId, (previous) => {
            if (previous.has(agent.id)) return previous;
            const next = new Map(previous);
            next.set(agent.id, agent);
            return next;
          });
        }
        model.reconcile(sessions.getState().sessions);
        model.rememberTitle(
          entry.serverId,
          entry.agentId,
          cached(entry)?.title ?? agent.title,
        );
        attempt.tag = "ready";
      } catch (error) {
        if (!stopped && currentAttempt(entry, attempt)) {
          attempt.tag = "error";
          console.warn(
            "[global-workspace-tabs] Agent metadata lookup failed",
            entry.serverId,
            entry.agentId,
            error,
          );
        }
      } finally {
        running--;
        if (!stopped) {
          notify();
          schedule();
        }
      }
    }
    function pump() {
      if (stopped || typeof getPaseoClient !== "function") return;
      model.reconcile(sessions.getState().sessions);
      const entries = model.entries();
      if (pruneAttempts(entries)) notify();
      for (const entry of entries) {
        const agent = cached(entry);
        if (agent) {
          if (entry.title !== agent.title)
            model.rememberTitle(entry.serverId, entry.agentId, agent.title);
          continue;
        }
        const session = sessionFor(entry);
        if (!session?.client || session.client.isConnected === false) continue;
        const existing = attempts.get(keyOf(entry));
        if (existing && sameConnection(entry, existing)) continue;
        if (running >= 4) break;
        const attempt = {
          tag: "loading",
          client: session.client,
          generation: session.clientGeneration,
          connection: connections.get(entry.serverId),
        };
        attempts.set(keyOf(entry), attempt);
        running++;
        notify();
        void fetch(entry, attempt);
      }
    }
    releases.push(
      model.subscribe(onModelChanged),
      sessions.subscribe(onSessionsChanged),
    );
    onSessionsChanged();
    return {
      state,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      revision: () => revision,
      dispose() {
        stopped = true;
        releases.forEach((release) => release());
        listeners.clear();
        attempts.clear();
        connections.clear();
        sessionMetadata.clear();
      },
    };
  }
  return { createLoader };
})();
  globalThis.PaseoGlobalTabsHistory = (function () {
  "use strict";
  const origin = "global-workspace-tabs";
  function install({ model, layouts, functions, reopen, navigate, pathname, terminal, shortcuts }) {
    if (!reopen || typeof layouts.getState().recordClosedTab !== "function") {
      return { restore: () => false, onKey() {}, dispose() {} };
    }
    const close = model.close;
    let stopped = false;
    function closeWithHistory(key) {
      const entries = model.entries();
      const index = entries.findIndex((entry) => entry.key === key);
      const entry = entries[index];
      close(key);
      if (stopped || !entry || model.entries().some((item) => item.key === key)) return;
      const workspaceKey = entry.serverId + ":" + entry.workspaceId;
      const tree = layouts.getState().layoutByWorkspace[workspaceKey];
      const tab = tree && functions.collectAllTabs(tree.root).find((tab) => tab.tabId === entry.tabId);
      const pane = tree && functions.findPaneContainingTab(tree.root, entry.tabId);
      layouts.getState().recordClosedTab(workspaceKey, {
        tab: tab || { tabId: entry.tabId, target: { kind: "agent", agentId: entry.agentId }, createdAt: Date.now() },
        paneId: pane?.id ?? null, browserUrl: null, origin, position: index,
      });
    }
    model.close = closeWithHistory;
    function restore() {
      if (stopped) return false;
      while (!stopped) {
        const route = pathname().match(/^\/h\/([^/]+)\/workspace\/([^/]+)/);
        let workspaceKey = route ? decodeURIComponent(route[1]) + ":" + decodeURIComponent(route[2]) : null;
        const histories = layouts.getState().closedTabsByWorkspace;
        let selected = workspaceKey ? histories[workspaceKey]?.at(-1) : null;
        for (const [key, entries] of Object.entries(histories)) {
          const candidate = entries.at(-1);
          if (candidate?.origin === origin && (!selected || (candidate.sequence ?? 0) > (selected.sequence ?? 0))) {
            workspaceKey = key; selected = candidate;
          }
        }
        if (!workspaceKey || selected?.origin !== origin || selected.tab.target.kind !== "agent") return false;
        const boundary = workspaceKey.lastIndexOf(":");
        const serverId = workspaceKey.slice(0, boundary), workspaceId = workspaceKey.slice(boundary + 1);
        if (model.retainAt(serverId, workspaceId, selected.tab, selected.position) === null) {
          const state = layouts.getState();
          if (typeof state.takeLastClosedTab !== "function" || state.closedTabsByWorkspace[workspaceKey]?.at(-1) !== selected) return false;
          state.takeLastClosedTab(workspaceKey);
          continue;
        }
        reopen({ workspaceKey, createTerminal: terminal });
        navigate({ serverId, workspaceId, target: selected.tab.target, placement: { mode: "focused" } });
        return true;
      }
      return false;
    }
    function onKey(event) {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey === event.metaKey || !event.shiftKey || event.altKey || event.code !== "KeyT") return;
      const state = shortcuts?.getState();
      if (state?.commandCenterOpen || state?.shortcutsDialogOpen || state?.capturingShortcut) return;
      if (!restore()) return;
      event.preventDefault(); event.stopImmediatePropagation?.();
    }
    return { restore, onKey, dispose() { stopped = true; if (model.close === closeWithHistory) model.close = close; } };
  }
  return { install };
})();
  (function () {
  "use strict";
  const ids = globalThis.__PASEO_GLOBAL_TABS_MODULES__;
  const requireModule = globalThis.__r;
  const React = requireModule(ids.react);
  const rowsModule = requireModule(ids.rows);
  const presentationModule = requireModule(ids.presentation);
  const navigation = requireModule(ids.navigation);
  const sessions = requireModule(ids.sessions).useSessionStore;
  const layouts = requireModule(ids.layouts).useWorkspaceLayoutStore;
  const parseWorkspaceRoute = requireModule(ids.hostRoutes).parseHostWorkspaceRouteFromPathname;
  const normalizeAgentSnapshot = requireModule(ids.snapshots).normalizeAgentSnapshot;
  const useKeyboardActionHandler = requireModule(ids.keyboardActions).useKeyboardActionHandler;
  const titleSelectors = ids.titles == null ? null : requireModule(ids.titles);
  const useSettings = ids.settings == null ? null : requireModule(ids.settings).useSettings;
  const draftBridge = ids.newWorkspaceTabs == null ? null : requireModule(ids.newWorkspaceTabs).newWorkspaceTabsBridge;
  const presenceBridge = ids.tabPresence == null ? null : requireModule(ids.tabPresence).agentTabPresenceBridge;
  const groupModule = ids.tabGroups == null ? null : requireModule(ids.tabGroups);
  const originalRow = rowsModule.WorkspaceDesktopTabsRow;
  const originalPresentation = presentationModule.WorkspaceTabPresentationResolver;
  let storage;
  try { storage = globalThis.localStorage; } catch {}
  const projectWindow = globalThis.paseoDesktop?.projectWindow || null;
  const model = globalThis.PaseoGlobalTabsModel.createModel(storage, () => sessions.getState().sessions, projectWindow);
  let storageWarningShown = false;
  function reportStorageStatus() {
    const status = model.storageStatus();
    if (status.state !== "memory-only" || storageWarningShown) return;
    storageWarningShown = true;
    console.warn("[global-workspace-tabs] " + status.message);
  }
  const releaseStorageStatus = model.subscribe(reportStorageStatus);
  reportStorageStatus();
  const metadata = globalThis.PaseoGlobalTabsMetadata.createLoader({ model, sessions, normalizeAgentSnapshot,
    getPaseoClient: typeof getPaseoClient === "function" ? getPaseoClient : null });
  const sources = new Map();
  const keyboardSources = new Map();
  const bySyntheticId = new Map();
  const timers = new Set();
  const virtualTabs = new Map();
  const handoffs = new Map();
  const knownDrafts = new Map();
  const draftSlots = new Map();
  const projectionListeners = new Set();
  const draftPresentations = new Map();
  const agentPresentations = new Map();
  const agentDescriptors = new Map();
  let indexedRevision = -1;
  let entriesByAgent = new Map();
  let sessionModelRevision = -1;
  let sessionServerIds = [];
  let tabSessions = {};
  function getTabSessions() {
    const current = sessions.getState().sessions;
    const revision = model.revision();
    if (revision !== sessionModelRevision) sessionServerIds = [...new Set(model.entries().map(entry => entry.serverId))];
    const selected = {};
    let changed = false;
    for (const serverId of sessionServerIds) {
      const next = current[serverId];
      const previous = tabSessions[serverId];
      if (next?.agents === previous?.agents && next?.agentDetails === previous?.agentDetails && next?.workspaces === previous?.workspaces) {
        if (previous) selected[serverId] = previous;
      } else {
        changed = true;
        if (next) selected[serverId] = { agents: next.agents, agentDetails: next.agentDetails, workspaces: next.workspaces };
      }
    }
    if (changed || Object.keys(selected).length !== Object.keys(tabSessions).length) tabSessions = selected;
    sessionModelRevision = revision;
    return tabSessions;
  }
  let draftOrder = [];
  let projectionRevision = 0;
  let bridgeState = draftBridge?.getSnapshot() || { entries: [], activeDraftId: null, completions: [] };
  const pinnedDrafts = new Set([...(typeof previousDraftPins === "undefined" ? [] : previousDraftPins),
    ...bridgeState.entries.filter((entry) => draftBridge?.hasInput?.(entry.draftId)).map((entry) => entry.draftId)]);
  let reconcilingPreview = false;
  let observedPreview = model.preview()?.key;
  let lastCompletion = Math.max(0, ...(bridgeState.completions || []).map((item) => item.sequence));
  bridgeState.entries.forEach((entry) => knownDrafts.set(entry.draftId, entry));
  let rendered = false;
  let disposed = false;
  let pinIntent = null;
  let cycleCursor = null;
  const pendingNativeCloses = new Set();
  const dismissPreview = model.close;
  const history = globalThis.PaseoGlobalTabsHistory.install({
    model, layouts, functions: requireModule(ids.layouts),
    reopen: ids.reopen == null ? null : requireModule(ids.reopen).reopenLastClosedWorkspaceTab,
    shortcuts: ids.shortcuts == null ? null : requireModule(ids.shortcuts).useKeyboardShortcutsStore,
    navigate: navigation.navigateToWorkspace, pathname: () => globalThis.location?.pathname || "",
    terminal() {},
  });
  const prefix = "global-agent:";
  const draftPrefix = "global-new-workspace:";
  const virtualId = (draftId) => draftPrefix + JSON.stringify(draftId);
  const syntheticId = (entry) => prefix + entry.key;
  function syncGroupSources() {
    if (!groupModule) return;
    const store = groupModule.useTabGroups.getState();
    const current = store.state;
    const replacements = new Map();
    const groups = current.groups.map(group => ({ ...group, tabs: group.tabs.map(tab => {
      if (tab.target.kind !== "agent" || !tab.key.startsWith(prefix)) return tab;
      const source = tab.groupSource;
      const entry = model.entries().find(item => item.serverId === source?.serverId && item.agentId === tab.target.agentId);
      if (!entry) return tab;
      const key = syntheticId(entry);
      if (tab.key === key && source.workspaceId === entry.workspaceId && source.tabId === entry.tabId) return tab;
      replacements.set(tab.key, key);
      return { ...tab, key, tabId: key, groupSource: { serverId: entry.serverId, workspaceId: entry.workspaceId, tabId: entry.tabId } };
    }) }));
    if (replacements.size) store.update(state => ({ ...state, groups,
      order: [...new Set(state.order.map(key => replacements.get(key) || key))] }));
  }
  const releaseGroupModel = model.subscribe(syncGroupSources);
  const releaseGroupStore = groupModule ? groupModule.useTabGroups.subscribe(syncGroupSources) : () => {};
  syncGroupSources();
  const liveKey = (props) => props.globalDraftContext ? JSON.stringify(["new-workspace", props.globalDraftId])
    : JSON.stringify([props.normalizedServerId, props.normalizedWorkspaceId]);
  const paneKey = (props) => JSON.stringify([liveKey(props), props.paneId]);
  function lookup(tabId) {
    const cached = bySyntheticId.get(tabId);
    if (!cached) return;
    if (indexedRevision !== model.revision()) {
      const entries = model.entries();
      entriesByAgent = new Map(entries.map(entry => [JSON.stringify([entry.serverId, entry.agentId]), entry]));
      const keys = new Set(entries.map(syntheticId));
      for (const key of agentPresentations.keys()) if (!keys.has(key)) agentPresentations.delete(key);
      for (const key of agentDescriptors.keys()) if (!keys.has(key)) agentDescriptors.delete(key);
      indexedRevision = model.revision();
    }
    return entriesByAgent.get(JSON.stringify([cached.serverId, cached.agentId]));
  }
  function shallowEqual(left, right) {
    if (left === right) return true;
    if (!left || !right) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
  }
  function stableAgentPresentation(key, next) {
    const previous = agentPresentations.get(key);
    const keys = Object.keys(next);
    if (previous && keys.length === Object.keys(previous).length && keys.every(name => Object.hasOwn(previous, name)
      && (name === "titleLines" ? shallowEqual(previous[name], next[name]) : previous[name] === next[name]))) return previous;
    agentPresentations.set(key, next);
    return next;
  }
  function lookupVirtual(tabId) { return virtualTabs.get(tabId); }
  function notifyProjection() {
    projectionRevision++;
    projectionListeners.forEach((listener) => listener());
  }
  function subscribeProjection(listener) { projectionListeners.add(listener); return () => projectionListeners.delete(listener); }
  function pinDraft(draftId) {
    if (!knownDrafts.has(draftId) || pinnedDrafts.has(draftId)) return false;
    pinnedDrafts.add(draftId);
    draftPresentations.delete(virtualId(draftId));
    notifyProjection();
    return true;
  }
  // Agent previews and empty workspace drafts share one temporary tab slot.
  // Replacing a draft only removes its tab; its saved input remains recoverable.
  function replacePreview(draftId) {
    if (reconcilingPreview) return;
    reconcilingPreview = true;
    try {
      if (draftId && model.preview()) dismissPreview(model.preview().key);
      for (const entry of [...bridgeState.entries]) {
        if (entry.kind === "history" || entry.draftId === draftId || pinnedDrafts.has(entry.draftId)) continue;
        if (draftBridge.hasInput?.(entry.draftId)) { pinDraft(entry.draftId); continue; }
        draftBridge.close(entry.draftId, { preserveDraft: true });
      }
      observedPreview = model.preview()?.key;
    } finally { reconcilingPreview = false; }
  }
  const releasePreview = model.subscribe(() => {
    const key = model.preview()?.key;
    if (!reconcilingPreview && key && key !== observedPreview) replacePreview(null);
    observedPreview = model.preview()?.key;
  });
  function setDraftOrder(keys) {
    let count = 0;
    draftOrder = [];
    for (const key of keys) {
      if (key.startsWith(prefix)) count++;
      else if (key.startsWith(draftPrefix)) {
        const draftId = JSON.parse(key.slice(draftPrefix.length));
        draftSlots.set(draftId, count);
        draftOrder.push(draftId);
      }
    }
  }
  function visibleEntries(state) {
    return model.entries().filter((entry) => {
      if(groupModule&&!groupModule.isTabGroupKeyVisible(syntheticId(entry)))return false;
      return !model.isArchived(entry.serverId, entry.agentId);
    });
  }
  function globalItems(state, snapshot = bridgeState) {
    virtualTabs.clear();
    const agents = visibleEntries(state).map((entry) => ({ key: syntheticId(entry), entry }));
    const drafts = [...snapshot.entries, ...[...handoffs.values()].filter((entry) => !snapshot.entries.some((item) => item.draftId === entry.draftId))];
    const rank = new Map(draftOrder.map((id, index) => [id, index]));
    drafts.sort((left, right) => (rank.get(left.draftId) ?? draftOrder.length) - (rank.get(right.draftId) ?? draftOrder.length));
    const slots = new Map();
    drafts.forEach((draft) => {
      if (!draftSlots.has(draft.draftId)) draftSlots.set(draft.draftId, agents.length);
      const position = Math.min(draftSlots.get(draft.draftId), agents.length);
      const item = { key: virtualId(draft.draftId), draft };
      virtualTabs.set(item.key, draft);
      if (!slots.has(position)) slots.set(position, []);
      slots.get(position).push(item);
    });
    return agents.flatMap((agent, index) => [...(slots.get(index) || []), agent]).concat(slots.get(agents.length) || []);
  }
  function syncBridge() {
    if (disposed) return;
    let before = globalItems(sessions.getState().sessions);
    bridgeState = draftBridge.getSnapshot();
    const added = bridgeState.entries.filter(entry => !knownDrafts.has(entry.draftId) && entry.kind !== "history");
    bridgeState.entries.forEach((entry) => {
      knownDrafts.set(entry.draftId, entry);
      if (draftBridge.hasInput?.(entry.draftId)) pinDraft(entry.draftId);
    });
    for (const completion of [...(bridgeState.completions || [])].sort((left, right) => left.sequence - right.sequence)) {
      if (completion.sequence <= lastCompletion) continue;
      lastCompletion = completion.sequence;
      const draft = knownDrafts.get(completion.draftId);
      if (!draft) continue;
      const id = virtualId(completion.draftId);
      const position = before.findIndex((item) => item.key === id);
      if (completion.target?.kind === "agent" && completion.tabId) {
        const prior = before.slice(0, position < 0 ? before.length : position).filter((item) => item.entry).at(-1)?.entry;
        const index = prior ? model.entries().findIndex((entry) => entry.key === prior.key) + 1 : 0;
        const tab = { tabId: completion.tabId, target: completion.target };
        const agentKey = prefix + model.keyOf(completion.serverId, completion.workspaceId, tab.tabId);
        setDraftOrder(before.map((item) => item.key === id ? agentKey : item.key));
        handoffs.delete(completion.draftId);
        knownDrafts.delete(completion.draftId);
        draftSlots.delete(completion.draftId);
        const entry = model.retainAt(completion.serverId, completion.workspaceId, tab, index);
        before = before.map((item) => item.key === id ? { key: agentKey, entry } : item);
      } else if (completion.target && completion.tabId) {
        handoffs.set(completion.draftId, { ...draft, serverId: completion.serverId, workspaceId: completion.workspaceId,
          target: completion.target, tabId: completion.tabId });
        before = before.map((item) => item.key === id ? { key: id, draft: handoffs.get(completion.draftId) } : item);
      } else {
        handoffs.delete(completion.draftId);
        knownDrafts.delete(completion.draftId);
        draftSlots.delete(completion.draftId);
        before = before.filter((item) => item.key !== id);
      }
    }
    for (const id of knownDrafts.keys()) {
      if (!bridgeState.entries.some((entry) => entry.draftId === id) && !handoffs.has(id)) knownDrafts.delete(id);
    }
    for (const id of pinnedDrafts) if (!knownDrafts.has(id)) pinnedDrafts.delete(id);
    const previewDraft = added.filter(entry => !pinnedDrafts.has(entry.draftId)).at(-1);
    if (previewDraft) replacePreview(previewDraft.draftId);
    notifyProjection();
  }
  function currentSelection() {
    return typeof globalThis.location?.pathname === "string" ? parseWorkspaceRoute(globalThis.location.pathname) : null;
  }
  function cycleSelection() {
    if (draftBridge && ["/new", "/sessions"].includes(globalThis.location?.pathname) && bridgeState.activeDraftId) {
      return { draftId: bridgeState.activeDraftId };
    }
    return currentSelection();
  }
  function selectionKey(selection) {
    return selection.draftId ? JSON.stringify(["new-workspace", selection.draftId])
      : JSON.stringify([selection.serverId, selection.workspaceId]);
  }
  function findPane(node, paneId) {
    if (!node) return null;
    if (node.kind === "pane") return node.pane.id === paneId ? node.pane : null;
    for (const child of node.group?.children || []) {
      const pane = findPane(child, paneId);
      if (pane) return pane;
    }
    return null;
  }
  function activeTarget(selection, paneId) {
    if (!selection) return null;
    const layout = layouts.getState().layoutByWorkspace[selection.serverId + ":" + selection.workspaceId];
    const pane = findPane(layout?.root, paneId || layout?.focusedPaneId);
    const source = [...(sources.get(JSON.stringify([selection.serverId, selection.workspaceId]))?.values() || [])]
      .find(item => paneId ? item.paneId === paneId : item.isFocused !== false);
    const tab = pane ? pane.tabs.find((item) => item.tabId === pane.focusedTabId)
      : source?.tabs.find(item => item.isActive)?.tab;
    return tab?.target?.kind === "agent" ? tab : null;
  }
  function pinSelected(selection, paneId, agentId) {
    const tab = activeTarget(selection, paneId);
    if (!tab || (agentId && tab.target.agentId !== agentId)) return false;
    const state = sessions.getState().sessions;
    const session = state[selection.serverId];
    const agent = session?.agents.get(tab.target.agentId) || session?.agentDetails.get(tab.target.agentId);
    if (agent?.workspaceId && agent.workspaceId !== selection.workspaceId) return false;
    model.reconcile(state);
    model.ingest(selection.serverId, selection.workspaceId, [{ tab, isActive: true }]);
    const entry = model.entries().find((item) => item.serverId === selection.serverId
      && item.workspaceId === selection.workspaceId && item.agentId === tab.target.agentId);
    if (!entry) return false;
    model.pin(entry.key);
    return true;
  }
  function flushPinIntent() {
    if (!pinIntent || disposed) return;
    if (Date.now() > pinIntent.expires) { pinIntent = null; return; }
    const selection = currentSelection();
    if (!selection || selection.serverId !== pinIntent.serverId
      || (pinIntent.workspaceId && selection.workspaceId !== pinIntent.workspaceId)) return;
    const intent = pinIntent;
    pinIntent = null;
    if (!pinSelected(selection, null, intent.agentId)) pinIntent = intent;
  }
  function eventElement(event) {
    return event.target?.nodeType === 3 ? event.target.parentElement : event.target;
  }
  function ancestors(element) {
    const result = [];
    for (let node = element; node?.getAttribute; node = node.parentElement) result.push(node);
    return result;
  }
  function actionInside(element, row) {
    return ancestors(element).some((node) => node !== row && row.contains(node)
      && (node.tagName === "BUTTON" || node.getAttribute("role") === "button"
        || node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable));
  }
  function onDoubleClick(event) {
    const element = eventElement(event);
    const nodes = ancestors(element);
    const state = sessions.getState().sessions;
    const selection = currentSelection();
    for (const node of nodes) {
      const id = node.getAttribute("data-testid") || "";
      const draft = virtualTabs.get(id.slice("workspace-tab-".length));
      if (id.startsWith("workspace-tab-" + draftPrefix) && draft) {
        if (!actionInside(element, node)) pinDraft(draft.draftId);
        return;
      }
      if (id.startsWith("workspace-tab-agent_")) {
        if (!selection || actionInside(element, node)) return;
        const agentId = id.slice("workspace-tab-agent_".length);
        const entry = model.entries().find((item) => item.serverId === selection.serverId && item.agentId === agentId);
        if (entry) model.pin(entry.key);
        else {
          pinIntent = { serverId: selection.serverId, workspaceId: selection.workspaceId, agentId, expires: Date.now() + 2500 };
          flushPinIntent();
        }
        return;
      }
      for (const serverId of Object.keys(state)) {
        const workspacePrefix = "sidebar-workspace-row-" + serverId + ":";
        const agentPrefix = "agent-row-" + serverId + "-";
        const activityPrefix = "sidebar-activity-session-" + serverId + "-";
        if (!id.startsWith(workspacePrefix) && !id.startsWith(agentPrefix) && !id.startsWith(activityPrefix)) continue;
        if (actionInside(element, node)) return;
        pinIntent = { serverId, expires: Date.now() + 2500,
          ...(id.startsWith(workspacePrefix) ? { workspaceId: id.slice(workspacePrefix.length) }
            : { agentId: id.slice(id.startsWith(activityPrefix) ? activityPrefix.length : agentPrefix.length) }) };
        flushPinIntent();
        return;
      }
    }
  }
  let lastClick = null;
  function onClick(event) {
    if (event.isTrusted === false || event.button > 0) return;
    const element = eventElement(event);
    const row = ancestors(element).find(node => /^(sidebar-activity-session-|sidebar-workspace-row-|agent-row-)/.test(node.getAttribute("data-testid") || ""));
    if (!row || actionInside(element, row)) { lastClick = null; return; }
    const id = row.getAttribute("data-testid");
    const now = Date.now();
    if (lastClick?.id === id && now - lastClick.time <= 500) {
      lastClick = null;
      onDoubleClick(event);
    } else lastClick = { id, time: now };
  }
  function onDraftInput(event) {
    if (event.isTrusted === false) return;
    const element = eventElement(event);
    if (!element?.hasAttribute?.("data-composer-input") || element.disabled || element.readOnly) return;
    const nodes = ancestors(element);
    if (!nodes.some((node) => node.getAttribute("data-testid") === "message-input-root")) return;
    const inserted = typeof event.data === "string" && event.data.length > 0;
    const realDraft = typeof element.value === "string" && element.value.length > 0
      && (event.type === "input" && !String(event.inputType || "").startsWith("delete"));
    if (!inserted && !realDraft) return;
    if (draftBridge && globalThis.location?.pathname === "/new" && bridgeState.activeDraftId) {
      pinDraft(bridgeState.activeDraftId);
      return;
    }
    if (nodes.some((node) => node.getAttribute("data-testid") === "workspace-setup-dialog")) return;
    const paneNode = nodes.find((node) => (node.getAttribute("data-testid") || "").startsWith("workspace-pane-"));
    const selection = currentSelection();
    if (selection) pinSelected(selection, paneNode?.getAttribute("data-testid").slice("workspace-pane-".length));
  }
  function visibleOverlay(node) {
    if (ancestors(node).some((item) => item.hidden || item.getAttribute("aria-hidden") === "true")) return false;
    if (typeof node.getClientRects === "function" && node.getClientRects().length === 0) return false;
    const style = globalThis.window?.getComputedStyle?.(node);
    return !style || (style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse");
  }
  function keyboardBlocked() {
    if (globalThis.document?.visibilityState === "hidden") return true;
    if (!globalThis.document?.querySelectorAll) return false;
    const selector = '[role="dialog"],[role="alertdialog"],[aria-modal="true"],[data-testid="command-center-panel"],[data-menu-surface="true"]';
    if ([...document.querySelectorAll(selector)].some(visibleOverlay)) return true;
    try { return [...document.querySelectorAll(":popover-open")].some(visibleOverlay); }
    catch { return false; }
  }
  function focusedKeyboardSource(selection) {
    if (selection.draftId) return [...keyboardSources.values()].find((source) => source.globalDraftContext
      && source.globalDraftId === selection.draftId && source.isFocused !== false) || null;
    const candidates = [...keyboardSources.values()].filter((source) => source.normalizedServerId === selection.serverId
      && source.normalizedWorkspaceId === selection.workspaceId && source.isFocused !== false
      && source.ownsKeyboardShortcuts !== false);
    const layout = layouts.getState().layoutByWorkspace[selection.serverId + ":" + selection.workspaceId];
    if (layout?.focusedPaneId) return candidates.find((source) => source.paneId === layout.focusedPaneId) || null;
    return candidates.length === 1 ? candidates[0] : null;
  }
  function cycleRows(source, visibleOnly = false, includeKey) {
    const rows = [...globalItems(sessions.getState().sessions),
      ...source.tabs.filter((row) => row.tab.target.kind !== "agent")
        .filter((row) => ![...handoffs.values()].some((entry) => entry.serverId === source.normalizedServerId
          && entry.workspaceId === source.normalizedWorkspaceId && entry.tabId === row.tab.tabId))
        .map((row) => ({ key: JSON.stringify([paneKey(source), row.tab.tabId]), tab: row.tab }))];
    if (!groupModule) return rows;
    // The host projects group order after receiving our rows. Use that same order
    // for navigation, including collapsed members (activation expands the group).
    const state = groupModule.useTabGroups.getState().state;
    const byKey = new Map(rows.map(row => [row.tab?.key ?? row.key, row])
      .filter(([key]) => groupModule.isTabGroupKeyVisible(key)));
    const order = [...state.order.filter(key => byKey.has(key)),
      ...[...byKey.keys()].filter(key => !state.order.includes(key))];
    const membership = new Map(state.groups.flatMap(group => group.tabs.map(tab => [tab.key, group])));
    const seen = new Set();
    const result = [];
    for (const key of order) {
      const group = membership.get(key);
      if (!group) { result.push(byKey.get(key)); continue; }
      if (seen.has(group.id) || group.closed) continue;
      seen.add(group.id);
      for (const member of group.tabs) {
        const row = byKey.get(member.key);
        if (row && (!visibleOnly || !group.collapsed || row.key === includeKey)) result.push(row);
      }
    }
    return result;
  }
  function activeCycleKey(source, rows) {
    if (source.globalDraftContext) return bridgeState.activeDraftId ? virtualId(bridgeState.activeDraftId) : null;
    const layout = layouts.getState().layoutByWorkspace[source.normalizedServerId + ":" + source.normalizedWorkspaceId];
    const pane = findPane(layout?.root, source.paneId);
    const tab = pane ? pane.tabs.find((item) => item.tabId === pane.focusedTabId)
      : source.tabs.find((row) => row.isActive)?.tab;
    if (!tab) return null;
    return rows.find((row) => row.entry ? row.entry.serverId === source.normalizedServerId
      && row.entry.workspaceId === source.normalizedWorkspaceId && row.entry.agentId === tab.target?.agentId
      : row.draft ? row.draft.serverId === source.normalizedServerId && row.draft.workspaceId === source.normalizedWorkspaceId
        && row.draft.tabId === tab.tabId : row.tab.tabId === tab.tabId)?.key || null;
  }
  function resetCycle() { cycleCursor = null; }
  function onCycleKey(event) {
    if (disposed) return;
    if (event.key !== "Tab" || !event.ctrlKey || event.altKey || event.metaKey) {
      if (event.key !== "Control" && event.key !== "Shift") resetCycle();
      return;
    }
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || keyboardBlocked()) {
      resetCycle();
      return;
    }
    const selection = cycleSelection();
    if (!selection) { resetCycle(); return; }
    const now = Date.now();
    const recent = cycleCursor && now - cycleCursor.time < 1500;
    const selectedScope = selectionKey(selection);
    let source = focusedKeyboardSource(selection);
    if (!source && recent && cycleCursor.scopes.has(selectedScope)) {
      const previous = keyboardSources.get(cycleCursor.sourceKey);
      if (previous?.isFocused !== false && previous?.ownsKeyboardShortcuts !== false) source = previous;
    }
    if (!source) { resetCycle(); return; }
    const rows = cycleRows(source);
    if (!rows.length) { resetCycle(); return; }
    const scope = liveKey(source);
    const sourceKey = paneKey(source);
    const activeKey = activeCycleKey(source, rows);
    const continued = recent && cycleCursor.scopes.has(scope)
      && (!cycleCursor.panes.has(scope) || cycleCursor.panes.get(scope) === sourceKey)
      && cycleCursor.trail.has(activeKey) && rows.some((row) => row.key === cycleCursor.key);
    const previousKey = continued ? cycleCursor.key : activeKey;
    const index = rows.findIndex((row) => row.key === previousKey);
    const nextIndex = index < 0 ? (event.shiftKey ? rows.length - 1 : 0)
      : (index + (event.shiftKey ? -1 : 1) + rows.length) % rows.length;
    const target = rows[nextIndex];
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const cursor = continued ? cycleCursor : { trail: new Set([activeKey]), scopes: new Set([scope]), panes: new Map() };
    cursor.key = target.key;
    cursor.time = now;
    cursor.sourceKey = sourceKey;
    cursor.trail.add(target.key);
    cursor.panes.set(scope, sourceKey);
    if (target.entry) cursor.scopes.add(JSON.stringify([target.entry.serverId, target.entry.workspaceId]));
    if (target.draft) cursor.scopes.add(target.draft.target
      ? JSON.stringify([target.draft.serverId, target.draft.workspaceId])
      : JSON.stringify(["new-workspace", target.draft.draftId]));
    cycleCursor = cursor;
    if (target.key === previousKey) return;
    if (target.entry) activate(target.entry);
    else if (target.draft) activateVirtual(target.draft);
    else source.onNavigateTab(target.tab.tabId);
  }
  const documentEvents = [["click", onClick], ["dblclick", onDoubleClick], ["input", onDraftInput],
    ["compositionupdate", onDraftInput], ["compositionend", onDraftInput]];
  if (globalThis.document?.addEventListener) documentEvents.forEach(([name, listener]) => document.addEventListener(name, listener, true));
  function onStorage(event) {
    if (globalThis.PaseoGlobalTabsModel.isWindowStorageEvent(event.key, projectWindow)) model.synchronize();
  }
  function onGlobalKey(event) {
    history.onKey(event);
    if (!event.defaultPrevented) onCycleKey(event);
  }
  function onAgentDeleted(event) {
    const { serverId, agentId } = event.detail || {};
    if (typeof serverId !== "string" || !serverId || typeof agentId !== "string" || !agentId) return;
    model.forgetAgent(serverId, agentId);
  }
  const windowEvents = [["keydown", onGlobalKey], ["pointerdown", resetCycle], ["blur", resetCycle], ["storage", onStorage], ["paseo:agent-deleted", onAgentDeleted]];
  if (globalThis.window?.addEventListener) windowEvents.forEach(([name, listener]) => window.addEventListener(name, listener, true));
  const releaseLayout = typeof layouts.subscribe === "function" ? layouts.subscribe(flushPinIntent) : () => {};
  function activate(entry) {
    navigation.navigateToWorkspace({ serverId: entry.serverId, workspaceId: entry.workspaceId,
      target: { kind: "agent", agentId: entry.agentId }, placement: { mode: "focused" } });
  }
  function activateVirtual(draft) {
    if (draft.target) navigation.navigateToWorkspace({ serverId: draft.serverId, workspaceId: draft.workspaceId,
      target: draft.target, placement: { mode: "focused" } });
    else draftBridge.activate(draft.draftId);
  }
  function activateItem(item, props) {
    if (item.entry) activate(item.entry);
    else if (item.draft) activateVirtual(item.draft);
    else if (item.tab) props.onNavigateTab(item.tab.tabId);
  }
  function closeVirtual(draft, props, preserveGroup=false, preserveDraft=false) {
    if (draft.target) return sourceAction(draft, "onCloseTab", draft.tabId,
      source => closeNative(draft.tabId, source, { draft, preserveGroup }),
      () => forgetUnreachable(draft, props, preserveGroup));
    const items = cycleRows(props, true, virtualId(draft.draftId));
    const index = items.findIndex((item) => item.key === virtualId(draft.draftId));
    const replacement = items[index + 1] || items[index - 1];
    if(!preserveGroup)groupModule?.forgetTabGroupKey(virtualId(draft.draftId));
    const active = props.globalDraftContext && bridgeState.activeDraftId === draft.draftId;
    knownDrafts.delete(draft.draftId);
    draftSlots.delete(draft.draftId);
    draftBridge.close(draft.draftId, {preserveDraft});
    if (!active) return;
    if (replacement) activateItem(replacement, props);
    else {
      const selected = navigation.getLastWorkspaceSelection();
      if (selected) navigation.navigateToWorkspace({ ...selected, target: { kind: "new_tab" }, placement: { mode: "focused" } });
      else draftBridge.dismiss?.();
    }
  }
  // No pane ever mounts for a workspace that no longer exists, so close the tab without one.
  function forgetUnreachable(draft, props, preserveGroup) {
    const id = virtualId(draft.draftId);
    const items = cycleRows(props, true, id);
    const index = items.findIndex((item) => item.key === id);
    const replacement = items[index + 1] || items[index - 1];
    const selected = currentSelection();
    const shown = selected?.serverId === draft.serverId && selected.workspaceId === draft.workspaceId;
    if (!preserveGroup) groupModule?.forgetTabGroupKey(id);
    handoffs.delete(draft.draftId);
    knownDrafts.delete(draft.draftId);
    draftSlots.delete(draft.draftId);
    pinnedDrafts.delete(draft.draftId);
    layouts.getState().closeTab?.(draft.serverId + ":" + draft.workspaceId, draft.tabId);
    notifyProjection();
    if (!shown) return;
    if (replacement) activateItem(replacement, props);
    else draftBridge?.dismiss?.();
  }
  function sourceAction(entry, name, value, action, onUnreachable) {
    const sourceForEntry = () => {
      const registered = [...(sources.get(JSON.stringify([entry.serverId, entry.workspaceId]))?.values() || [])];
      return registered.find(source => source.isFocused !== false) || registered[0];
    };
    const source = sourceForEntry();
    if (source) return action ? action(source) : source[name](value);
    if (entry.target) activateVirtual(entry);
    else activate(entry);
    let attempts = 0;
    const timer = setInterval(() => {
      const source = sourceForEntry();
      if (source || ++attempts >= 30) { clearInterval(timer); timers.delete(timer); }
      if (source) { if (action) action(source); else source[name](value); }
      else if (attempts >= 30) onUnreachable?.();
    }, 50);
    timers.add(timer);
  }
  function closeGlobal(entry, props, preserveGroup = false) {
    const ordered = cycleRows(props, true, syntheticId(entry));
    const index = ordered.findIndex((item) => item.key === syntheticId(entry));
    const replacement = ordered[index + 1] || ordered[index - 1];
    if(!preserveGroup)groupModule?.forgetTabGroupKey(syntheticId(entry));
    const current = props.tabs.find((row) => row.isActive && row.tab.target.kind === "agent");
    const isActive = entry.serverId === props.normalizedServerId && entry.workspaceId === props.normalizedWorkspaceId
      && current?.tab.target.agentId === entry.agentId;
    model.close(entry.key);
    if (isActive && replacement) activateItem(replacement, props);
    if (isActive && !replacement) props.onCreateNewTab({ paneId: props.paneId });
  }
  function closeNative(tabId, source, virtual) {
    const key = JSON.stringify([paneKey(source), tabId]);
    if (pendingNativeCloses.has(key)) return;
    const includeKey = virtual ? virtualId(virtual.draft.draftId) : JSON.stringify([paneKey(source), tabId]);
    const items = cycleRows(source, true, includeKey);
    const index = items.findIndex(item => item.tab?.tabId === tabId || item.draft?.tabId === tabId);
    const replacement = items[index + 1] || items[index - 1];
    const active = index >= 0 && activeCycleKey(source, items) === items[index].key;
    pendingNativeCloses.add(key);
    let result;
    try { result = source.onCloseTab(tabId); }
    catch (error) { pendingNativeCloses.delete(key); throw error; }
    const release = () => pendingNativeCloses.delete(key);
    return Promise.resolve(result).then(() => {
      release();
      if (disposed) return;
      const layout = layouts.getState().layoutByWorkspace[source.normalizedServerId + ":" + source.normalizedWorkspaceId];
      const pane = findPane(layout?.root, source.paneId);
      // A canceled confirmation leaves the native tab in place.
      const remaining = pane?.tabs.find(tab => tab.tabId === tabId);
      // The host keeps the last root launcher alive; global tabs can still
      // leave it by selecting their visible neighbor.
      const rootLauncher = remaining?.target.kind === "new_tab" && pane.tabs.length === 1;
      if (!layout || remaining && !rootLauncher) return;
      if (virtual) {
        const id = virtual.draft.draftId;
        if (!virtual.preserveGroup) groupModule?.forgetTabGroupKey(virtualId(id));
        handoffs.delete(id);
        knownDrafts.delete(id);
        draftSlots.delete(id);
        pinnedDrafts.delete(id);
        notifyProjection();
      }
      const selected = currentSelection();
      if (!active || selected?.serverId !== source.normalizedServerId || selected.workspaceId !== source.normalizedWorkspaceId) return;
      if (replacement) activateItem(replacement, source);
      else if (rootLauncher) draftBridge?.dismiss?.();
    }, release);
  }
  function closeCurrentShownTab() {
    const selection = cycleSelection();
    const source = selection && focusedKeyboardSource(selection);
    if (!source) return false;
    const items = cycleRows(source);
    const activeKey = activeCycleKey(source, items);
    const item = items.find((candidate) => candidate.key === activeKey);
    resetCycle();
    if (!item) return true;
    if (item.entry) closeGlobal(item.entry, source);
    else if (item.draft) closeVirtual(item.draft, source);
    else closeNative(item.tab.tabId, source);
    return true;
  }
  presentationModule.WorkspaceTabPresentationResolver = function GlobalTabPresentation(props) {
    React.useSyncExternalStore(metadata.subscribe, metadata.revision, metadata.revision);
    React.useSyncExternalStore(model.subscribe, model.revision, model.revision);
    React.useSyncExternalStore(subscribeProjection, () => projectionRevision, () => projectionRevision);
    // The collection owns the session subscription. Individual presentations
    // read its latest snapshot without adding a hot-store listener per tab.
    const sessionState = sessions.getState().sessions;
    const settings = useSettings ? useSettings().settings : null;
    const draft = lookupVirtual(props.tab.tabId);
    if (draft) {
      if (draft.target) return React.createElement(originalPresentation, { ...props, serverId: draft.serverId,
        workspaceId: draft.workspaceId, tab: { ...props.tab, key: draft.tabId, tabId: draft.tabId } });
      if (!draftPresentations.has(props.tab.key)) {
        const history = draft.kind === "history";
        const label = history ? "기록" : "새 워크스페이스";
        const icon = ({ size = 14, color }) => React.createElement("span", { style: { fontSize: size, color } }, history ? "◷" : "+");
        draftPresentations.set(props.tab.key, { key: props.tab.key, kind: "new_tab", label, tooltip: label,
          subtitle: "", modified: false, showCloseButton: true, titleState: "ready", icon, statusBucket: null, isPreview: history ? false : !pinnedDrafts.has(draft.draftId) });
      }
      return props.children(draftPresentations.get(props.tab.key));
    }
    const entry = lookup(props.tab.tabId);
    if (!entry) return React.createElement(originalPresentation, props);
    return React.createElement(originalPresentation, { ...props, serverId: entry.serverId, workspaceId: entry.workspaceId,
      tab: { ...props.tab, key: entry.tabId, tabId: entry.tabId }, children(presentation) {
        let titlePresentation = { ...presentation, isPreview: !entry.pinned };
        if (titleSelectors && settings) {
          const context = { ...entry, defaultLabel: presentation.label };
          const session = sessionState[entry.serverId];
          const sidebarLabel = titleSelectors.selectAgentTabSidebarLabel({ session, context,
            workspaceTitleSource: settings.workspaceTitleSource });
          if (sidebarLabel !== null) {
            const projectLabel = titleSelectors.selectAgentTabProjectLabel({ session, context });
            const label = projectLabel ? projectLabel + "-" + sidebarLabel : sidebarLabel;
            titlePresentation = { ...titlePresentation, label, tooltip: label, titleState: "ready",
              titleLines: projectLabel ? { primaryLabel: projectLabel, secondaryLabel: sidebarLabel,
                ...(presentation.completedAt != null ? { completedAt: presentation.completedAt } : {}) } : undefined };
          }
        }
        if (titlePresentation.titleState === "ready") return props.children(stableAgentPresentation(props.tab.tabId, titlePresentation));
        const status = metadata.state(entry);
        const title = (typeof entry.title === "string" && entry.title) || (status.tag === "ready" ? "대화" : status.tag === "missing" ? "대화를 찾을 수 없음"
          : status.tag === "mismatch" ? "대화 소속 확인 필요" : status.tag === "error" ? "대화 정보 확인 실패" : null);
        if (!title) return props.children(stableAgentPresentation(props.tab.tabId, titlePresentation));
        return props.children(stableAgentPresentation(props.tab.tabId,
          { ...titlePresentation, label: title, tooltip: title, titleState: "ready" }));
      } });
  };
  rowsModule.WorkspaceDesktopTabsRow = function GlobalWorkspaceTabs(props) {
    if (props.host !== "explorer") rendered = true;
    const [hovered, setHovered] = React.useState(null);
    React.useSyncExternalStore(model.subscribe, model.revision, model.revision);
    React.useSyncExternalStore(subscribeProjection, () => projectionRevision, () => projectionRevision);
    if(groupModule) groupModule.useTabGroups(state=>state.state);
    const sessionState = React.useSyncExternalStore(sessions.subscribe, getTabSessions, getTabSessions);
    const lastSelection = navigation.useLastWorkspaceSelection();
    const relevant = props.host !== "explorer";
    useKeyboardActionHandler({
      handlerId: "global-workspace-tabs:close:" + paneKey(props),
      actions: ["workspace.tab.close-current"], enabled: relevant, priority: 1000,
      isActive() {
        if (disposed) return false;
        const selection = cycleSelection();
        const source = selection && focusedKeyboardSource(selection);
        return Boolean(source && paneKey(source) === paneKey(props));
      },
      handle: closeCurrentShownTab,
    });
    useKeyboardActionHandler({
      handlerId: "global-workspace-tabs:reopen:" + paneKey(props),
      actions: ["workspace.tab.reopen"], enabled: relevant, priority: 1000,
      isActive: () => !disposed,
      handle: history.restore,
    });
    const activeWorkspace = relevant && !props.globalDraftContext && lastSelection?.serverId === props.normalizedServerId
      && lastSelection?.workspaceId === props.normalizedWorkspaceId && props.isFocused !== false;
    React.useEffect(() => {
      if (!relevant) return;
      if (!props.globalDraftContext) {
        if (!sources.has(liveKey(props))) sources.set(liveKey(props), new Map());
        sources.get(liveKey(props)).set(paneKey(props), props);
      }
      keyboardSources.set(paneKey(props), props);
      model.reconcile(sessionState);
      if (activeWorkspace) model.ingest(props.normalizedServerId, props.normalizedWorkspaceId, props.tabs);
      flushPinIntent();
      return () => {
        if (keyboardSources.get(paneKey(props)) === props) keyboardSources.delete(paneKey(props));
        const registered = sources.get(liveKey(props));
        if (registered?.get(paneKey(props)) === props) registered.delete(paneKey(props));
        if (registered?.size === 0) sources.delete(liveKey(props));
      };
    }, [props, relevant, activeWorkspace, sessionState]);
    if (!relevant) return React.createElement(originalRow, props);
    const localAgents = new Map(props.tabs.filter(row => row.tab.target.kind === "agent").map(row => [row.tab.target.agentId, row]));
    const globalRows = globalItems(sessionState).map((item) => {
      if (item.draft) {
        const draft = item.draft;
        const target = draft.target || { kind: "new_tab" };
        const active = props.globalDraftContext ? bridgeState.activeDraftId === draft.draftId
          : draft.target && draft.serverId === props.normalizedServerId && draft.workspaceId === props.normalizedWorkspaceId
            && props.tabs.some((row) => row.isActive && row.tab.tabId === draft.tabId);
        return { tab: { key: item.key, tabId: item.key, ...(draft.target?{}:{groupDraft:{draftId:draft.draftId,serverId:draft.serverId,href:draft.href,...(draft.kind?{kind:draft.kind}:{})}}), kind: target.kind, target },
          isActive: Boolean(active), isCloseHovered: hovered === item.key, isClosingTab: false };
      }
      const entry = item.entry;
      const id = syntheticId(entry);
      bySyntheticId.set(id, entry);
      const local = entry.serverId === props.normalizedServerId && entry.workspaceId === props.normalizedWorkspaceId
        ? localAgents.get(entry.agentId) : null;
      if (agentDescriptors.get(id)?.target.agentId !== entry.agentId) agentDescriptors.set(id,
        { key: id, tabId: id, groupSource: {serverId:entry.serverId,workspaceId:entry.workspaceId,tabId:entry.tabId}, kind: "agent", target: { kind: "agent", agentId: entry.agentId } });
      return { tab: agentDescriptors.get(id),
        isActive: Boolean(local?.isActive), isCloseHovered: hovered === id, isClosingTab: false };
    });
    const otherRows = props.tabs.filter((row) => row.tab.target.kind !== "agent")
      .filter(row=>!groupModule||groupModule.isTabGroupKeyVisible(row.tab.key))
      .filter((row) => ![...handoffs.values()].some((entry) => entry.serverId === props.normalizedServerId
        && entry.workspaceId === props.normalizedWorkspaceId && entry.tabId === row.tab.tabId));
    const tabs = [...globalRows, ...otherRows];
    const close = (tabId) => {
      const entry = lookup(tabId);
      const draft = lookupVirtual(tabId);
      return entry ? closeGlobal(entry, props) : draft ? closeVirtual(draft, props) : closeNative(tabId, props);
    };
    const actOnAgent = (name, agentId, tab) => {
      const matching = model.entries().filter(item => item.agentId === agentId);
      const entry = tab ? lookup(tab.tabId) : matching.length === 1 ? matching[0] : null;
      if (tab?.tabId.startsWith(prefix) && !entry) return;
      if (!entry && matching.length > 1) return;
      return entry ? sourceAction(entry, name, agentId) : props[name](agentId);
    };
    const closeRange = (tabId, predicate) => {
      const ordered = cycleRows(props, true).map(item => tabs.find(row => row.tab.tabId === (item.tab?.tabId || item.key))).filter(Boolean);
      const index = ordered.findIndex((row) => row.tab.tabId === tabId);
      if (index < 0) return;
      const selected = ordered.filter((row, i) => predicate(i, index));
      selected.filter((row) => !row.isActive).forEach((row) => close(row.tab.tabId));
      selected.filter((row) => row.isActive).forEach((row) => close(row.tab.tabId));
    };
    return React.createElement(originalRow, { ...props, tabs, externalDndContext: false,
      activeDragTabId: null, tabDropPreviewIndex: null,
      setHoveredCloseTabKey(key) {
        setHovered(key);
        props.setHoveredCloseTabKey(key && !lookup(key) ? key : null);
      },
      onNavigateTab(tabId) {
        const entry = lookup(tabId);
        const draft = lookupVirtual(tabId);
        return entry ? activate(entry) : draft ? activateVirtual(draft) : props.onNavigateTab(tabId);
      },
      onCloseGroupedTabs(tabIds, preserveDraft=true) { for(const tabId of tabIds) {const entry=lookup(tabId),draft=lookupVirtual(tabId); if(entry)closeGlobal(entry,props,true);else if(draft)closeVirtual(draft,props,true,preserveDraft);else close(tabId);} },
      onKeepTab(tab) { const entry=lookup(tab.tabId), draft=lookupVirtual(tab.tabId); if(entry)model.pin(entry.key);else if(draft)pinDraft(draft.draftId); },
      onCloseTab: close,
      onCloseTabsToLeft: (id) => closeRange(id, (i, index) => i < index),
      onCloseTabsToRight: (id) => closeRange(id, (i, index) => i > index),
      onCloseOtherTabs: (id) => closeRange(id, (i, index) => i !== index),
      onCopyResumeCommand: (id, tab) => actOnAgent("onCopyResumeCommand", id, tab),
      onCopyAgentId: (id, tab) => actOnAgent("onCopyAgentId", id, tab),
      onReloadAgent: (id, tab) => actOnAgent("onReloadAgent", id, tab),
      onRenameTab(tab) {
        const draft = lookupVirtual(tab.tabId);
        if (draft) return draft.target ? sourceAction(draft, "onRenameTab", { ...tab, key: draft.tabId, tabId: draft.tabId }) : undefined;
        const entry = lookup(tab.tabId);
        if (!entry && tab.tabId.startsWith(prefix)) return;
        return entry ? sourceAction(entry, "onRenameTab", { ...tab, key: entry.tabId, tabId: entry.tabId }) : props.onRenameTab(tab);
      },
      onReorderTabs(next) {
        setDraftOrder(next.map((tab) => tab.tabId));
        model.reorder(next.map((tab) => lookup(tab.tabId)?.key).filter(Boolean));
        const local = next.flatMap((tab) => {
          if (lookupVirtual(tab.tabId)) return [];
          const entry = lookup(tab.tabId);
          if (!entry) return [tab];
          if (entry.serverId !== props.normalizedServerId || entry.workspaceId !== props.normalizedWorkspaceId) return [];
          return [{ ...tab, key: entry.tabId, tabId: entry.tabId }];
        });
        const included = new Set(local.map((tab) => tab.tabId));
        const orderedLocal = [...local, ...props.tabs.map((row) => row.tab).filter((tab) => !included.has(tab.tabId))];
        if (!props.globalDraftContext && orderedLocal.some((tab,index)=>tab.tabId !== props.tabs[index]?.tab.tabId)) props.onReorderTabs(orderedLocal);
      },
    });
  };
  function NewWorkspaceTabsBar() {
    React.useSyncExternalStore(subscribeProjection, () => projectionRevision, () => projectionRevision);
    const draft = bridgeState.entries.find((entry) => entry.draftId === bridgeState.activeDraftId);
    if (!draft) return null;
    const noop = () => {};
    return React.createElement(rowsModule.WorkspaceDesktopTabsRow, {
      globalDraftContext: true, globalDraftId: draft.draftId, host: "main", paneId: "new-workspace",
      normalizedServerId: draft.serverId, normalizedWorkspaceId: "", isFocused: true, ownsKeyboardShortcuts: true,
      tabs: [], focusModeEnabled: false, showPaneSplitActions: false, showPaneMaximizeAction: false,
      setHoveredCloseTabKey: noop, onNavigateTab: noop, onCloseTab: noop, onCopyResumeCommand: noop,
      onCopyAgentId: noop, onCopyTerminalId: noop, onCopyFilePath: noop, onReloadAgent: noop,
      onRenameTab: noop, onCloseTabsToLeft: noop, onCloseTabsToRight: noop, onCloseOtherTabs: noop,
      onCreateNewTab: () => draftBridge.open({ serverId: draft.serverId }), onReorderTabs: noop, onExitFocusMode: noop,
    });
  }
  const releaseBridge = draftBridge ? draftBridge.subscribe(syncBridge) : () => {};
  const initialPreviewDraft = bridgeState.entries.filter(entry => entry.kind !== "history" && !pinnedDrafts.has(entry.draftId)).at(-1);
  if (initialPreviewDraft) replacePreview(initialPreviewDraft.draftId);
  const releaseBar = draftBridge ? draftBridge.registerTabBar(NewWorkspaceTabsBar) : () => {};
  const releasePresence = presenceBridge ? presenceBridge.register({read: model.tabPresence, subscribe: model.subscribe,
    closeWorkspace: ({serverId, workspaceId}) => model.closeWorkspace(serverId, workspaceId),
    retain: ({serverId, workspaceId, agentId, tabId}) => {
      const entries = model.entries();
      const index = entries.findIndex(entry => entry.serverId === serverId && entry.agentId === agentId);
      model.retainAt(serverId, workspaceId, {tabId, target: {kind: "agent", agentId}}, index < 0 ? entries.length : index);
    }}) : () => {};
  globalThis.__PASEO_GLOBAL_TABS__ = { version: 2, performanceVersion: 2, model, pinnedDrafts, dispose() {
    if (disposed) return;
    disposed = true;
    resetCycle();
    pendingNativeCloses.clear();
    releaseBar();
    releaseBridge();
    releasePreview();
    releasePresence();
    releaseStorageStatus();
    releaseGroupModel();
    releaseGroupStore();
    projectionListeners.clear();
    virtualTabs.clear();
    handoffs.clear();
    knownDrafts.clear();
    draftSlots.clear();
    draftPresentations.clear();
    agentPresentations.clear();
    agentDescriptors.clear();
    entriesByAgent.clear();
    pinIntent = null;
    releaseLayout();
    history.dispose();
    if (globalThis.document?.removeEventListener) documentEvents.forEach(([name, listener]) => document.removeEventListener(name, listener, true));
    if (globalThis.window?.removeEventListener) windowEvents.forEach(([name, listener]) => window.removeEventListener(name, listener, true));
    metadata.dispose();
    rowsModule.WorkspaceDesktopTabsRow = originalRow;
    presentationModule.WorkspaceTabPresentationResolver = originalPresentation;
    timers.forEach(clearInterval);
    sources.clear();
    keyboardSources.clear();
    bySyntheticId.clear();
    delete globalThis.__PASEO_GLOBAL_TABS__;
  } };
  let refreshAttempts = 0;
  const refreshTimer = setInterval(() => {
    if (rendered || ++refreshAttempts > 100) {
      clearInterval(refreshTimer);
      timers.delete(refreshTimer);
      return;
    }
    const selected = navigation.getLastWorkspaceSelection();
    if (!selected) return;
    const key = selected.serverId + ":" + selected.workspaceId;
    const state = layouts.getState();
    const layout = state.layoutByWorkspace[key];
    if (!layout) return;
    // 이미 마운트된 React 컴파일러 캐시가 새 탭 행을 참조하도록 동일 값의 새 객체를 전달한다.
    layouts.setState({ layoutByWorkspace: { ...state.layoutByWorkspace, [key]: structuredClone(layout) } });
  }, 100);
  timers.add(refreshTimer);
  console.info("[global-workspace-tabs] ready");
})();

  const installed = globalThis.__PASEO_GLOBAL_TABS__;
  lease ??= { owners: new Set() };
  lease.controller = installed;
  lease.revision = revision;
  globalThis[leaseKey] = lease;
  return retain(lease);
}
