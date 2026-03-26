import { describe, expect, test } from "bun:test";
import { matchChain, parseSelector } from "./print.js";
import type { PlainNode } from "./types.js";

describe("print", () => {
  const tree: PlainNode = {
    _tag: "Root",
    _children: [
      {
        _tag: "Application",
        _id: "app:com.test",
        _children: [
          {
            _tag: "Window",
            _id: "Window:Main:0",
            title: "Main",
            _children: [
              {
                _tag: "Button",
                _id: "Button:Commit:0",
                label: "Commit",
                _children: [
                  { _tag: "Image", _id: "Image:Icon:0", label: "Icon" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  test("prints the matched leaf path once when the property is on the matched node", () => {
    const selectors = [
      parseSelector("Application#com.test"),
      parseSelector("Window#Main"),
      parseSelector("Button#Commit"),
    ];
    const matches = matchChain(tree, selectors, "label");

    expect(matches).toEqual([
      {
        path: "/Application#com.test/Window#Main/Button#Commit.label",
        value: "Commit",
      },
      {
        path: "/Application#com.test/Window#Main/Button#Commit/Image#Icon.label",
        value: "Icon",
      },
    ]);
  });
});
