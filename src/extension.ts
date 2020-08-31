"use strict";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as mkdirp from "mkdirp";
import { compact, startsWith, sortBy } from "lodash";
import * as gitignoreToGlob from "gitignore-to-glob";
import { sync as globSync } from "glob";
import * as Cache from "vscode-cache";
import { QuickPickItem, ViewColumn } from "vscode";

export interface FSLocation {
  relative: string;
  absolute: string;
}

export interface WorkspaceRoot {
  rootPath: string;
  baseName: string;
  multi: boolean;
}

export interface DirectoryOption {
  displayText: string;
  fsLocation: FSLocation;
}

declare module "vscode" {
  interface QuickPickItem {
    option?: DirectoryOption;
    uri?: vscode.Uri;
  }
}

function isFolderDescriptor(filepath: string): boolean {
  return filepath.charAt(filepath.length - 1) === path.sep;
}

function invertGlob(pattern: string): string {
  return pattern.replace(/^!/, "");
}

function walkupGitignores(dir: string, found: string[] = []): string[] {
  const gitignore = path.join(dir, ".gitignore");
  if (fs.existsSync(gitignore)) found.push(gitignore);

  const parentDir = path.resolve(dir, "..");
  const reachedSystemRoot = dir === parentDir;

  if (!reachedSystemRoot) {
    return walkupGitignores(parentDir, found);
  } else {
    return found;
  }
}

function flatten(memo: any[], item: any): any[] {
  return memo.concat(item);
}

function gitignoreGlobs(root: string): string[] {
  const gitignoreFiles = walkupGitignores(root);
  return gitignoreFiles.map((g) => gitignoreToGlob(g)).reduce(flatten, []);
}

function configIgnoredGlobs(root: string): string[] {
  const configFilesExclude = Object.assign(
    [],
    vscode.workspace.getConfiguration("advancedNewFile").get("exclude"),
    vscode.workspace.getConfiguration("files.exclude", vscode.Uri.file(root))
  );
  const configIgnored = Object.keys(configFilesExclude).filter(
    (key) => configFilesExclude[key] === true
  );

  return gitignoreToGlob(configIgnored.join("\n"), { string: true });
}

function directoriesSync(root: string): FSLocation[] {
  const ignore = gitignoreGlobs(root)
    .concat(configIgnoredGlobs(root))
    .map(invertGlob);

  const results = globSync("**", { cwd: root, ignore })
    .map(
      (f): FSLocation => {
        return {
          relative: path.join(path.sep, f),
          absolute: path.join(root, f),
        };
      }
    )
    .filter((f) => fs.statSync(f.absolute).isDirectory())
    .map((f) => f);

  return results;
}

function convenienceOptions(
  roots: WorkspaceRoot[],
  cache: Cache
): vscode.QuickPickItem[] {
  const config: string[] = vscode.workspace
    .getConfiguration("advancedNewFile")
    .get("convenienceOptions");

  const optionsByName = {
    last: [buildQuickPickItem(lastSelection(cache), "- last selection")],
    current: [
      buildQuickPickItem(currentEditorPathOption(roots), "- current file"),
    ],
    root: rootOptions(roots).map((o) =>
      buildQuickPickItem(o, "- workspace root")
    ),
  };

  const options = config
    .map<vscode.QuickPickItem[]>((c) => optionsByName[c])
    .reduce(flatten);

  return compact<vscode.QuickPickItem>(options);
}

async function subdirOptionsForRoot(
  root: WorkspaceRoot
): Promise<DirectoryOption[]> {
  const dirs = await directories(root.rootPath);

  return dirs.map(
    (dir: FSLocation): DirectoryOption => {
      const displayText = root.multi
        ? path.join(path.sep, root.baseName, dir.relative)
        : dir.relative;

      return {
        displayText,
        fsLocation: dir,
      };
    }
  );
}

export function showQuickPick(
  choices: Promise<vscode.QuickPickItem[]>
): Thenable<QuickPickItem> {
  return vscode.window.showQuickPick<vscode.QuickPickItem>(choices, {
    placeHolder:
      "First, select an existing path " +
      "(larger projects may take a moment to load)",
  });
}

export async function showInputBox(
  baseDirectory: DirectoryOption
): Promise<string> {
  try {
    const input = await vscode.window.showInputBox({
      prompt: `Relative to ${baseDirectory.displayText}`,
      placeHolder: "Filename or relative path to file",
    });

    return path.join(baseDirectory.fsLocation.absolute, input);
  } catch (e) {
    return;
  }
}

export function directories(root: string): Promise<FSLocation[]> {
  return new Promise((resolve, reject) => {
    const findDirectories = () => {
      try {
        resolve(directoriesSync(root));
      } catch (error) {
        reject(error);
      }
    };

    const delayToAllowVSCodeToRender = 1;
    setTimeout(findDirectories, delayToAllowVSCodeToRender);
  });
}

export function buildQuickPickItem(
  option: DirectoryOption,
  description: string = null
): vscode.QuickPickItem {
  if (!option) return;

  return {
    label: option.displayText,
    description,
    option,
  };
}

export function currentEditorPath(): string {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) return;

  return path.dirname(activeEditor.document.fileName);
}

export function createFileOrFolder(absolutePath: string): void {
  let directoryToFile = path.dirname(absolutePath);

  if (!fs.existsSync(absolutePath)) {
    if (isFolderDescriptor(absolutePath)) {
      mkdirp.sync(absolutePath);
    } else {
      mkdirp.sync(directoryToFile);
      fs.appendFileSync(absolutePath, "");
    }
  }
}

export async function openFile(absolutePath: string): Promise<void> {
  if (isFolderDescriptor(absolutePath)) {
    const showInformationMessages = vscode.workspace
      .getConfiguration("advancedNewFile")
      .get("showInformationMessages", true);

    if (showInformationMessages) {
      vscode.window.showInformationMessage(`Folder created: ${absolutePath}`);
    }
  } else {
    const textDocument = await vscode.workspace.openTextDocument(absolutePath);

    if (textDocument) {
      await vscode.window.showTextDocument(textDocument, ViewColumn.Active);
    }
  }
}

export function lastSelection(cache: Cache): DirectoryOption {
  if (!cache.has("last")) return;
  const value = cache.get("last");

  if (typeof value === "object") {
    return value as DirectoryOption;
  } else {
    cache.forget("last");
    return;
  }
}

export function workspaceRoots(): WorkspaceRoot[] {
  if (vscode.workspace.workspaceFolders) {
    const multi = vscode.workspace.workspaceFolders.length > 1;

    return vscode.workspace.workspaceFolders.map((folder) => {
      return {
        rootPath: folder.uri.fsPath,
        baseName: path.basename(folder.uri.fsPath),
        multi,
      };
    });
  } else if (vscode.workspace.rootPath) {
    return [
      {
        rootPath: vscode.workspace.rootPath,
        baseName: path.basename(vscode.workspace.rootPath),
        multi: false,
      },
    ];
  } else {
    return [];
  }
}

export function rootOptions(roots: WorkspaceRoot[]): DirectoryOption[] {
  return roots.map(
    (root): DirectoryOption => {
      return {
        displayText: root.multi ? path.join(path.sep, root.baseName) : path.sep,
        fsLocation: {
          relative: path.sep,
          absolute: root.rootPath,
        },
      };
    }
  );
}

export function currentEditorPathOption(
  roots: WorkspaceRoot[]
): DirectoryOption {
  const currentFilePath = currentEditorPath();
  const currentFileRoot =
    currentFilePath &&
    roots.find((r) => currentFilePath.indexOf(r.rootPath) === 0);

  if (!currentFileRoot) return;

  const rootMatcher = new RegExp(`^${currentFileRoot.rootPath}`);
  let relativeCurrentFilePath = currentFilePath.replace(rootMatcher, "");

  relativeCurrentFilePath =
    relativeCurrentFilePath === "" ? path.sep : relativeCurrentFilePath;

  const displayText = currentFileRoot.multi
    ? path.join(path.sep, currentFileRoot.baseName, relativeCurrentFilePath)
    : relativeCurrentFilePath;

  return {
    displayText,
    fsLocation: {
      relative: relativeCurrentFilePath,
      absolute: currentFilePath,
    },
  };
}

export async function dirQuickPickItems(
  roots: WorkspaceRoot[],
  cache: Cache
): Promise<vscode.QuickPickItem[]> {
  const dirOptions = await Promise.all(
    roots.map(async (r) => await subdirOptionsForRoot(r))
  );
  let quickPickItems = dirOptions
    .reduce(flatten)
    .map((o) => buildQuickPickItem(o));

  quickPickItems.unshift(...convenienceOptions(roots, cache));

  return quickPickItems;
}

export function cacheSelection(
  cache: Cache,
  dir: DirectoryOption,
  root: WorkspaceRoot
) {
  cache.put("last", dir);

  let recentRoots = cache.get("recentRoots") || [];

  const rootIndex = recentRoots.indexOf(root.rootPath);
  if (rootIndex >= 0) recentRoots.splice(rootIndex, 1);

  recentRoots.unshift(root.rootPath);
  cache.put("recentRoots", recentRoots);
}

export function sortRoots(
  roots: WorkspaceRoot[],
  desiredOrder: string[]
): WorkspaceRoot[] {
  return sortBy(roots, (root) => {
    const desiredIndex = desiredOrder.indexOf(root.rootPath);
    return desiredIndex >= 0 ? desiredIndex : roots.length;
  });
}

export function rootForDir(
  roots: WorkspaceRoot[],
  dir: DirectoryOption
): WorkspaceRoot {
  return roots.find((r) => startsWith(dir.fsLocation.absolute, r.rootPath));
}

export async function command(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const selection = editor.selection;
  const selectionText = editor.document.getText(selection);
  if (selectionText.length === 0) {
    vscode.window.showErrorMessage("There isn't any text selected.");
    return;
  }
  const roots = workspaceRoots();

  if (roots.length > 0) {
    const cacheName = roots.map((r) => r.rootPath).join(";");
    const cache = new Cache(context, `workspace:${cacheName}`);

    const sortedRoots = sortRoots(roots, cache.get("recentRoots") || []);

    const dirSelection = await showQuickPick(
      dirQuickPickItems(sortedRoots, cache)
    );
    if (!dirSelection) return;
    const dir = dirSelection.option;

    const selectedRoot = rootForDir(roots, dir);
    cacheSelection(cache, dir, selectedRoot);
    const localFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(dir.fsLocation.absolute, "*")
    );
    let choices: vscode.QuickPickItem[] = [
      ...localFiles.map((file) => {
        return {
          label: file.fsPath.slice(file.fsPath.lastIndexOf(path.sep) + 1),
          description: null,
          uri: file,
        };
      }),
      { label: "Create new file", description: null },
    ];
    const choice = await vscode.window.showQuickPick<vscode.QuickPickItem>(
      choices,
      { placeHolder: "Select existing file or create new file" }
    );
    if (!choice) return;
    if (choice.uri) {
      const fileUri = choice.uri;
      editor.edit((editBuilder) => {
        editBuilder.delete(selection);
      });
      const document = await vscode.workspace.openTextDocument(fileUri);
      const activeEditor = await vscode.window.showTextDocument(document);
      await activeEditor.edit((editBuilder) => {
        editBuilder.insert(
          document.lineAt(document.lineCount - 1).range.end,
          "\n" + selectionText
        );
      });
      activeEditor.document.save();
    } else {
      const newFileInput = await showInputBox(dir);
      if (!newFileInput) return;
      createFileOrFolder(newFileInput);
      editor.edit((editBuilder) => {
        editBuilder.delete(selection);
      });
      await openFile(newFileInput);
      const activeEditor = vscode.window.activeTextEditor;
      await activeEditor.edit((editBuilder) => {
        editBuilder.insert(new vscode.Position(0, 0), selectionText);
      });
      activeEditor.document.save();
      activeEditor.selection = new vscode.Selection(
        new vscode.Position(0, 0),
        new vscode.Position(0, 0)
      );
    }
  } else {
    await vscode.window.showErrorMessage(
      "It doesn't look like you have a folder opened in your workspace. " +
        "Try opening a folder first."
    );
  }
}

export function activate(context: vscode.ExtensionContext) {
  let disposable = vscode.commands.registerCommand(
    "extension.moveSelectionToFile",
    () => command(context)
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
