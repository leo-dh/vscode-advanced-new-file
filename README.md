# VSCode Move Selection

Fork of [VSCode Advanced New File](https://github.com/patbenatar/vscode-advanced-new-file)

Manually move code selection to a new or existing file when code refactor/extraction isn't working

Simple demonstration

![Demo Animation](https://github.com/leo-dh/vscode-move-selection/blob/master/animation.gif)

## Configuration Example

```
"moveSelection.exclude": {
  "node_modules": true,
  "node_modules_electron": true,
  "dev": true,
  "dist": true
},
"moveSelection.showInformationMessages": true,
"moveSelection.convenienceOptions": ["last", "current", "root"]
```

## Usage

- Command palette: "Move Selection To File"
