/* eslint-disable react/jsx-key */
/* eslint-disable react/no-unknown-property */
// @flow strict-local

// NOTE: If you make changes in this file you need to save twice for the changes
// to appear in Firefox when running `npm start` due to a hacky cache busting
// technique.

const fs = require("fs");
const crypto = require("crypto");

const writeFile = require("write");

const config = require("../project.config");

type Point = [number, number];

type Colors = {|
  edges: string,
  surface: string,
  pointer: string,
|};

const COLORS = {
  pointer: "#323234",
  edges: "#bebebe",
  surface: "#ddd",
};

const BACKGROUND_COLORS = {
  light: "#f5f6f7",
  dark: "#323234",
};

// start
//   |\
//   | \
//   |  \
//   |   \
//   |    \
//   |     \
//   |l2 r2_\
//   | /\ \  r1
//   |/  \ \
// l1     \_\
//       l3  r3
function pointer({
  height,
  inset,
  tailLength,
}: {|
  height: number, // start–l1, start–r1
  inset: number, // l1–l2, r1–r2
  tailLength: number, // l2–l3, r2–r3
|}): Array<Point> {
  const start = [0, 0];

  const l1 = go({ fromPoint: start, angle: -90, length: height });
  const l2 = go({ fromPoint: l1, angle: 45, length: inset });
  const l3 = go({ fromPoint: l2, angle: -67.5, length: tailLength });

  const r1 = go({ fromPoint: start, angle: -45, length: height });
  const r2 = go({ fromPoint: r1, angle: 180, length: inset });
  const r3 = go({ fromPoint: r2, angle: -67.5, length: tailLength });

  return [l3, l2, l1, start, r1, r2, r3];
}

// Starting at (x, y), go `length` units in the direction of `angle`, which is
// measured between the x axis and the resulting vector.
function go({
  fromPoint: [x, y],
  angle,
  length,
}: {|
  fromPoint: Point,
  angle: number,
  length: number,
|}): Point {
  // First make a vector with the requested length.
  const point = [length, 0];
  // Then rotate it by the requested angle.
  const [a, b] = rotate(point, angle);
  // Finally move it so it starts at (x, y).
  return [a + x, b + y];
}

function rotate([x, y]: Point, angle: number): Point {
  const r = toRadians(angle);
  return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
}

function toRadians(degrees: number): number {
  return (degrees / 180) * Math.PI;
}

function render(
  size: number,
  colors: Colors,
  { opacity = 1 }: {| opacity: number |} = {}
): string {
  const surfaceRect = {
    left: size * (1 / 8),
    top: size * (1 / 24),
    width: size * (3 / 4),
    height: size * (5 / 6),
  };

  const numSparks = 6;
  const sparkOffset = size * (1 / 12);
  const sparkLength = size * (1 / 12);
  const sparkWidth = size * (1 / 24);
  const sparkAngle = 7.5;

  const sparkLeft = sparkLength + sparkOffset;
  const sparkTop =
    (sparkLength + sparkOffset) * Math.cos(toRadians(sparkAngle));

  const pointerPoints = pointer({
    height: size * (2 / 5),
    inset: size * 0.135,
    tailLength: size * (1 / 5),
  });

  const pointerWidth = Math.max(...pointerPoints.map(([x]) => x));
  const pointerHeight = Math.max(...pointerPoints.map(([, y]) => -y));

  const pointerLeft = Math.round(
    surfaceRect.left + (surfaceRect.width - pointerWidth) / 2 + sparkLeft / 2
  );
  const pointerTop = Math.round(
    surfaceRect.top + (surfaceRect.height - pointerHeight) / 2 + sparkTop / 2
  );

  const sparks = Array.from({ length: numSparks - 1 }, (_, n) => {
    const angle = -n * (360 / numSparks) + sparkAngle;

    const [x1, y1] = go({
      fromPoint: [pointerLeft, pointerTop],
      angle,
      length: sparkOffset,
    });

    const [x2, y2] = go({ fromPoint: [x1, y1], angle, length: sparkLength });

    return (
      <line
        x1={float(x1)}
        y1={float(y1)}
        x2={float(x2)}
        y2={float(y2)}
        stroke={colors.pointer}
        stroke-width={float(Math.max(1, sparkWidth))}
        stroke-linecap="round"
      />
    );
  });

  const pointerPointsString = pointerPoints
    .map(([x, y]) => `${float(pointerLeft + x)},${float(pointerTop - y)}`)
    .join(" ");

  const edgesRadius = integer(Math.max(2, size * (1 / 12)));
  const surfaceRadius = integer(Math.max(2, size * (1 / 16)));

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${size} ${size}`}
      width={String(size)}
      height={String(size)}
    >
      <g opacity={String(opacity)}>
        <rect
          x="0"
          y="0"
          width={integer(size)}
          height={integer(size)}
          rx={edgesRadius}
          ry={edgesRadius}
          fill={colors.edges}
        />
        <rect
          x={integer(surfaceRect.left)}
          y={integer(surfaceRect.top)}
          width={integer(surfaceRect.width)}
          height={integer(surfaceRect.height)}
          rx={surfaceRadius}
          ry={surfaceRadius}
          fill={colors.surface}
        />
        <polygon points={pointerPointsString} fill={colors.pointer} />
        {sparks}
      </g>
    </svg>
  );
}

const React = {
  createElement(
    tag: string,
    attributes: ?{ [key: string]: string },
    ...nestedChildren: Array<string | Array<string>>
  ): string {
    const children = [].concat(...nestedChildren);
    const attributesString = Object.entries(attributes)
      .filter(([key]) => !key.startsWith("__"))
      .map(([key, value]) => `${key}="${String(value)}"`)
      .join(" ");
    return [
      "<",
      tag,
      ...(attributesString === "" ? [] : [" ", attributesString]),
      ...(children.length === 0
        ? [" />"]
        : [
            ">\n",
            ...children.map(child => `${indent(child)}\n`),
            "</",
            tag,
            ">",
          ]),
    ].join("");
  },
};

function indent(string: string): string {
  return string.replace(/^(?!$)/gm, "  ");
}

function float(number: number): string {
  return number
    .toFixed(2)
    .replace(/\.[1-9]*0+$/, "")
    .replace(/\.$/, "");
}

function integer(number: number): string {
  return String(Math.round(number));
}

const testStyles = `
body {
  display: flex;
  flex-direction: column;
  margin: 0;
  min-height: 100vh;
}

.container {
  flex: 1;
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 10px;
}

.container > * + * {
  margin-left: 10px;
}
`.trim();

const testScript = `
for (const img of document.querySelectorAll("img")) {
  img.width /= window.devicePixelRatio;
}
`.trim();

function renderTestPage() {
  const variations = [
    [config.icons, BACKGROUND_COLORS.light],
    [config.icons, BACKGROUND_COLORS.dark],
    [config.iconsDisabled, BACKGROUND_COLORS.light],
    [config.iconsDisabled, BACKGROUND_COLORS.dark],
  ];

  const doc = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Icons</title>
        <style>{testStyles}</style>
      </head>
      <body>
        {variations.map(([icons, color]) => (
          <div class="container" style={`background-color: ${color};`}>
            {[]
              .concat(
                ...icons.svg.map((icon, index) => [icon, icons.png[index]])
              )
              .map(([size, path]) => (
                <img src={`../${path}`} width={integer(size)} />
              ))}
          </div>
        ))}
        <script>{testScript}</script>
      </body>
    </html>
  );

  return `<!doctype html>\n${doc}`;
}

function checksum(string: string): string {
  return crypto
    .createHash("md5")
    .update(string, "utf8")
    .digest("hex");
}

function makeChecksumFile(hash: string): string {
  return `// @flow strict-local
export default ${JSON.stringify(hash)};
`;
}

function writeFileIfNeeded(filepath: string, content: string) {
  let needed = undefined;
  try {
    const previous = fs.readFileSync(filepath, "utf8");
    needed = previous !== content;
  } catch {
    needed = true;
  }
  if (needed) {
    writeFile.sync(filepath, content);
  }
}

module.exports = () => {
  const all = [
    [config.icons.svg, { opacity: 1 }],
    [config.iconsDisabled.svg, { opacity: 0.5 }],
  ];

  for (const [icons, options] of all) {
    for (const [size, path] of icons) {
      writeFileIfNeeded(`${config.src}/${path}`, render(size, COLORS, options));
    }
  }

  const mainIcon = render(96, COLORS);

  writeFileIfNeeded(`${config.src}/${config.mainIcon}`, mainIcon);

  writeFileIfNeeded(`${config.src}/${config.iconsTestPage}`, renderTestPage());
  writeFileIfNeeded(
    `${config.src}/${config.iconsChecksum}`,
    makeChecksumFile(checksum(mainIcon))
  );

  return mainIcon;
};
