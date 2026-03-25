import * as Y from "yjs";
import { applyTree, type TreeNode } from "../a11y/refresher.js";

export class CRDTStore {
  readonly docs = new Map<string, Y.Doc>();

  getOrCreate(path: string): Y.Doc {
    let doc = this.docs.get(path);
    if (!doc) {
      doc = new Y.Doc();
      this.docs.set(path, doc);
    }
    return doc;
  }

  get(path: string): Y.Doc | undefined {
    return this.docs.get(path);
  }

  loadFromTree(path: string, tree: TreeNode): Y.Doc {
    applyTree(this, path, tree);
    return this.getOrCreate(path);
  }

  destroy(path: string): void {
    const doc = this.docs.get(path);
    if (doc) {
      doc.destroy();
      this.docs.delete(path);
    }
  }

  paths(): string[] {
    return [...this.docs.keys()];
  }
}
