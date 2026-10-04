import { MemoryStore } from "../../src/store/MemoryStore";
import { runStoreContract } from "../storeContract";

runStoreContract("MemoryStore", () => new MemoryStore());
