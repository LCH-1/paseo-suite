import assert from "node:assert/strict";
import test from "node:test";
import { portableState } from "../shared/portable";
import { restore } from "../client/storage";
import type { ClientState } from "../shared/model";

const host = (endpoint: string, type: "remoteSsh" | "directTcp") => ({ serverId: "remote", label: "Remote", connections: [{ id: "connection", type, ...(type === "remoteSsh" ? { host: endpoint } : { endpoint }) }] });

test("SSH remote names and IPv6 addresses sharing a local-address prefix stay portable", () => {
  for (const endpoint of ["localhost-office.example", "user@localhost-office.example", "localhost2", "127.office.example", "::1234", "user@[::1234]", "::10", "[::100]"]) {
    const state = { hosts: [host(endpoint, "remoteSsh")], preferences: {} };
    assert.deepEqual(portableState(state).hosts, state.hosts.map((entry) => ({ ...entry, preferredConnectionId: "connection" })), endpoint);
  }
});

test("TCP local spellings and SSH loopbacks are excluded after hostname normalization", () => {
  const local = ["localhost", "LOCALHOST.", "127.0.0.1", "127.23.4.5", "0.0.0.0", "::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:127.23.4.5"];
  for (const endpoint of local) {
    const bracketed = endpoint.includes(":") ? `[${endpoint}]` : endpoint;
    for (const [type, address] of [["remoteSsh", endpoint], ["remoteSsh", `user@${bracketed}`], ["directTcp", `ws://${bracketed}:6767/`], ["directTcp", `${bracketed}:6767`]] as const) assert.deepEqual(portableState({ hosts: [host(address, type)], preferences: {} }).hosts, [], `${type}: ${address}`);
  }
  for (const endpoint of ["127.1:6767", "2130706433:6767", "0x7f000001:6767", "0177.0.0.1:6767", "wss://name:password@localhost.:6767/"]) assert.deepEqual(portableState({ hosts: [host(endpoint, "directTcp")], preferences: {} }).hosts, [], endpoint);
});

test("remote TCP, LAN, relay and mixed-connection hosts retain only portable connections", () => {
  const connections: ClientState["hosts"][number]["connections"] = [
    { id: "local", type: "directTcp", endpoint: "[::ffff:127.0.0.1]:6767" },
    { id: "ssh", type: "remoteSsh", host: "user@localhost-company.example", sshPort: 22 },
    { id: "lan", type: "directTcp", endpoint: "192.168.1.5:6767" },
    { id: "v6", type: "directTcp", endpoint: "wss://[2001:db8::1]:6767" },
    { id: "dns", type: "directTcp", endpoint: "127.office.example:6767" },
    { id: "relay", type: "relay", relayEndpoint: "relay.paseo.sh", daemonPublicKeyB64: "synthetic-public-key" },
  ];
  const state = portableState({ hosts: [{ serverId: "mixed", connections, preferredConnectionId: "local" }], preferences: {} });
  assert.deepEqual(state.hosts[0].connections, connections.slice(1));
  assert.equal(state.hosts[0].preferredConnectionId, "ssh");
});

test("authoritative restoration keeps a machine's normalized loopback connection", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const local = { serverId: "this-machine", label: "This PC", connections: [{ id: "tcp", type: "directTcp", endpoint: "ws://LOCALHOST.:6767" }] };
  storage.setItem("@paseo:daemon-registry", JSON.stringify([local]));
  restore(storage, { hosts: [host("user@localhost-office.example", "remoteSsh")], preferences: {} }, { merge: false, hosts: true, preferences: false });
  const saved = JSON.parse(storage.getItem("@paseo:daemon-registry")!);
  assert.ok(saved.some((entry: any) => entry.serverId === "this-machine"));
  assert.ok(saved.some((entry: any) => entry.serverId === "remote"));
});
