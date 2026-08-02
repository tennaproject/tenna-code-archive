![Tenna Code Archive - Site for viewing and comparing DELTARUNE™ game script from all releases](/static/banner.svg)

[!IMPORTANT]
This project is a **hard** fork of [`utdrwiki/code-viewer`](https://github.com/utdrwiki/code-viewer). 
Original [MIT license](https://github.com/utdrwiki/code-viewer/blob/master/LICENSE) terms apply.
Huge thanks to original project contributors for their work!

Aim of this project is providing an easy way to view and compare game script from different releases of DELTARUNE™.
At current state, it vast majority of historical releases are included. 
New releases are added as they become available.

Official instance is available at [https://code.tennaproject.com](https://code.tennaproject.com).

## Features

Tenna Code Archive works completely in browser. 
Parts of source code are downloaded and decompressed on the fly as needed.
Covering all historical releases puts technical limitations on the project, that's why this isn't a fully static site.


### Timeline

![Timeline](/static/timeline.gif)

Interactive timeline allows you to visually navigate between different releases. Each square represents a single release, clicking on it opens browse view of that release.
Clicking on line between releases opens a diff view comparing code between two.

### Browse

![Browse](/static/browse.png)

Browse view lists all scripts for a given release. You can use search to find stuff inside the code.
Scripts contain full source code with additional annotations.

### Compare

![Compare](/static/compare.png)

Compare view shows a side-by-side diff between two releases.
You can filter the results to show only added, modified, removed or renumbered scripts. Renumbered status indicates that the changes are only related to asset IDs.

## Development

The project uses [Bun](https://bun.sh/) for dependency management, package scripts, and its JavaScript runtime.

Install dependencies:

```bash
bun install --frozen-lockfile
```

### Running

Start a development server:

```bash
bun run dev
```

### Building

Create a production build:

```bash
bun run build
```

### Contributing

Run linting, formatting, and type checking before submitting changes:

```bash
bun run check
```

## Contributors

- [@DaInfLoop](https://github.com/DaInfLoop) - original project contributor
- [@ezhevita](https://github.com/ezhevita) - original project contributor
- [@HushBugger](https://github.com/HushBugger) - original project contributor
- [@Jacky720](https://github.com/Jacky720) - original project contributor
- [@jjezewski](https://github.com/jjezewski) - creator & maintainer
- [@KockaAdmiralac](https://github.com/KockaAdmiralac) - original project contributor
- [@NotBuildingwalls](https://github.com/NotBuildingwalls) - original project contributor
- [@RedstoneWizard08](https://github.com/RedstoneWizard08) - original project contributor
- [@Remex-Remige](https://github.com/Remex-Remige) - original project contributor
- [@Xkeeper0](https://github.com/Xkeeper0) - original project contributor

## License

This project is licensed under the zlib License. See the [LICENSE](./LICENSE) file for details.
