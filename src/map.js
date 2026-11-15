import { earthTextureUrl } from "./assets.js";

const DEG_TO_RAD = Math.PI / 180;
const EARTH_KM_PER_DEGREE = 111.32;

function boundsCenter(bounds) {
  return {
    latitude: (bounds.south + bounds.north) / 2,
    longitude: (bounds.west + bounds.east) / 2,
  };
}

function geometryRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates ?? [];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat(1);
  return [];
}

export function createStudyMap(canvas, initial) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser does not support a 2D canvas map.");

  const image = new Image();
  image.src = earthTextureUrl;
  let bounds = initial.bounds;
  let center = initial.center;
  let footprint = null;
  let changeCells = [];
  let changeLayerVisible = false;
  const onChangeCellSelected = initial.onChangeCellSelected ?? (() => {});
  let zoom = 1;
  let pan = { x: 0, y: 0 };
  let dragStart = null;
  const onLocationSelected = initial.onLocationSelected ?? (() => {});
  let width = 0;
  let height = 0;
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);

  function viewBounds() {
    const longitudeSpan = Math.min(360, (bounds.east - bounds.west) * 2.2 / zoom);
    const latitudeSpan = Math.min(170, (bounds.north - bounds.south) * 2.2 / zoom);
    const aspect = width / Math.max(height, 1);
    const mapLongitudeSpan = Math.max(longitudeSpan, latitudeSpan * aspect);
    const mapLatitudeSpan = Math.max(latitudeSpan, longitudeSpan / Math.max(aspect, 0.1));
    const pixelsPerDegree = Math.min(width / mapLongitudeSpan, height / mapLatitudeSpan);
    const longitudeCenter = center.longitude - pan.x / pixelsPerDegree;
    const latitudeCenter = center.latitude + pan.y / pixelsPerDegree;
    return {
      west: longitudeCenter - mapLongitudeSpan / 2,
      east: longitudeCenter + mapLongitudeSpan / 2,
      south: Math.max(-90, latitudeCenter - mapLatitudeSpan / 2),
      north: Math.min(90, latitudeCenter + mapLatitudeSpan / 2),
    };
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, rect.width);
    height = Math.max(1, rect.height);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    draw();
  }

  function toPoint(longitude, latitude, view) {
    return {
      x: (longitude - view.west) / (view.east - view.west) * width,
      y: (view.north - latitude) / (view.north - view.south) * height,
    };
  }

  function drawTexture(view) {
    context.fillStyle = "#b9d9d4";
    context.fillRect(0, 0, width, height);
    if (!image.complete || !image.naturalWidth) return;

    const left = Math.max(-180, view.west);
    const right = Math.min(180, view.east);
    const top = Math.min(90, view.north);
    const bottom = Math.max(-90, view.south);
    if (left >= right || bottom >= top) return;
    const sx = (left + 180) / 360 * image.naturalWidth;
    const sy = (90 - top) / 180 * image.naturalHeight;
    const sw = (right - left) / 360 * image.naturalWidth;
    const sh = (top - bottom) / 180 * image.naturalHeight;
    const destinationTopLeft = toPoint(left, top, view);
    const destinationBottomRight = toPoint(right, bottom, view);
    context.save();
    context.globalAlpha = 0.94;
    context.drawImage(
      image,
      sx,
      sy,
      sw,
      sh,
      destinationTopLeft.x,
      destinationTopLeft.y,
      destinationBottomRight.x - destinationTopLeft.x,
      destinationBottomRight.y - destinationTopLeft.y,
    );
    context.restore();
  }

  function drawGrid(view) {
    const longitudeSpan = view.east - view.west;
    const latitudeSpan = view.north - view.south;
    const step = Math.max(0.1, 10 ** Math.floor(Math.log10(Math.max(longitudeSpan, latitudeSpan) / 5)));
    context.save();
    context.strokeStyle = "rgba(12, 44, 58, 0.22)";
    context.lineWidth = 0.7;
    context.fillStyle = "rgba(15, 44, 53, 0.78)";
    context.font = "10px 'IBM Plex Mono', monospace";
    context.beginPath();
    for (let longitude = Math.ceil(view.west / step) * step; longitude < view.east; longitude += step) {
      const start = toPoint(longitude, view.north, view);
      const end = toPoint(longitude, view.south, view);
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      if (start.x > 4 && start.x < width - 48) {
        context.fillText(`${Math.abs(longitude).toFixed(step < 1 ? 1 : 0)}°${longitude < 0 ? "W" : "E"}`, start.x + 4, 14);
      }
    }
    for (let latitude = Math.ceil(view.south / step) * step; latitude < view.north; latitude += step) {
      const start = toPoint(view.west, latitude, view);
      const end = toPoint(view.east, latitude, view);
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      if (start.y > 22 && start.y < height - 8) {
        context.fillText(`${Math.abs(latitude).toFixed(step < 1 ? 1 : 0)}°${latitude < 0 ? "S" : "N"}`, 8, start.y - 4);
      }
    }
    context.stroke();
    context.restore();
  }

  function drawBounds() {
    const corners = [
      [bounds.west, bounds.south],
      [bounds.east, bounds.south],
      [bounds.east, bounds.north],
      [bounds.west, bounds.north],
    ];
    context.beginPath();
    corners.forEach(([longitude, latitude], index) => {
      const point = toPoint(longitude, latitude, viewBounds());
      if (index === 0) context.moveTo(point.x, point.y);
      else context.lineTo(point.x, point.y);
    });
    context.closePath();
    context.fillStyle = "rgba(255, 154, 69, 0.16)";
    context.fill();
    context.strokeStyle = "#ff9a45";
    context.lineWidth = 2;
    context.setLineDash([6, 4]);
    context.stroke();
    context.setLineDash([]);

    const point = toPoint(center.longitude, center.latitude, viewBounds());
    context.beginPath();
    context.arc(point.x, point.y, 5, 0, Math.PI * 2);
    context.fillStyle = "#ff9a45";
    context.fill();
    context.strokeStyle = "#fff8ec";
    context.lineWidth = 2;
    context.stroke();
  }

  function drawFootprint() {
    const rings = geometryRings(footprint);
    if (!rings.length) return;
    const view = viewBounds();
    context.save();
    context.strokeStyle = "#43d9ff";
    context.fillStyle = "rgba(67, 217, 255, 0.18)";
    context.lineWidth = 2;
    context.setLineDash([4, 3]);
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 3) continue;
      context.beginPath();
      ring.forEach(([longitude, latitude], index) => {
        const point = toPoint(longitude, latitude, view);
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.closePath();
      context.fill();
      context.stroke();
    }
    context.restore();
  }

  function drawChangeCells(view) {
    if (!changeLayerVisible) return;
    context.save();
    context.lineWidth = 0.6;
    for (const cell of changeCells) {
      const bounds = cell.bounds_wgs84;
      const delta = Number(cell.median_delta_db);
      if (!Array.isArray(bounds) || bounds.length !== 4 || !Number.isFinite(delta)) continue;
      const topLeft = toPoint(bounds[0], bounds[3], view);
      const bottomRight = toPoint(bounds[2], bounds[1], view);
      const strength = Math.min(Math.abs(delta) / 6, 1);
      const validFraction = Math.max(0, Math.min(Number(cell.valid_pixel_fraction) || 0, 1));
      const target = delta < -0.05
        ? [57, 123, 255]
        : delta > 0.05
          ? [255, 154, 69]
          : [184, 199, 215];
      const color = [184, 199, 215].map((base, index) =>
        Math.round(base + (target[index] - base) * strength),
      );
      context.globalAlpha = 0.22 + 0.72 * validFraction;
      context.fillStyle = `rgb(${color.join(", ")})`;
      context.strokeStyle = "rgba(228, 241, 255, 0.3)";
      context.fillRect(
        topLeft.x,
        topLeft.y,
        bottomRight.x - topLeft.x,
        bottomRight.y - topLeft.y,
      );
      context.strokeRect(
        topLeft.x,
        topLeft.y,
        bottomRight.x - topLeft.x,
        bottomRight.y - topLeft.y,
      );
    }
    context.restore();
  }

  function inspectChangeCell(event) {
    const rect = canvas.getBoundingClientRect();
    const view = viewBounds();
    const longitude = view.west + (event.clientX - rect.left) / width * (view.east - view.west);
    const latitude = view.north - (event.clientY - rect.top) / height * (view.north - view.south);
    let selected = null;
    for (let index = changeLayerVisible ? changeCells.length - 1 : -1; index >= 0; index -= 1) {
      const cell = changeCells[index];
      const bounds = cell.bounds_wgs84;
      if (
        Array.isArray(bounds)
        && bounds.length === 4
        && longitude >= bounds[0]
        && longitude <= bounds[2]
        && latitude >= bounds[1]
        && latitude <= bounds[3]
      ) {
        selected = cell;
        break;
      }
    }
    if (selected) onChangeCellSelected(selected);
    else onLocationSelected(
      Math.max(-90, Math.min(90, latitude)),
      Math.max(-180, Math.min(180, longitude)),
    );
  }

  function drawScale(view) {
    const centerLatitude = (view.north + view.south) / 2;
    const widthKm = (view.east - view.west) * EARTH_KM_PER_DEGREE * Math.cos(centerLatitude * DEG_TO_RAD);
    const maxScalePixels = Math.min(130, width * 0.32);
    const candidateKm = widthKm * maxScalePixels / width;
    const power = 10 ** Math.floor(Math.log10(Math.max(candidateKm, 0.01)));
    const scaleKm = [5, 2, 1].map((factor) => factor * power).find((value) => value <= candidateKm) ?? power;
    const scalePixels = scaleKm / widthKm * width;
    context.save();
    context.strokeStyle = "#153d46";
    context.fillStyle = "#153d46";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(16, height - 20);
    context.lineTo(16 + scalePixels, height - 20);
    context.moveTo(16, height - 24);
    context.lineTo(16, height - 16);
    context.moveTo(16 + scalePixels, height - 24);
    context.lineTo(16 + scalePixels, height - 16);
    context.stroke();
    context.font = "10px 'IBM Plex Mono', monospace";
    context.fillText(`${scaleKm.toLocaleString()} km`, 18 + scalePixels, height - 16);
    context.restore();
    const scaleLabel = document.querySelector("#mapScale");
    if (scaleLabel) scaleLabel.textContent = `EQUIRECTANGULAR · APPROX. ${scaleKm.toLocaleString()} KM`;
  }

  function draw() {
    if (!width || !height) return;
    const view = viewBounds();
    context.clearRect(0, 0, width, height);
    drawTexture(view);
    drawGrid(view);
    drawFootprint();
    drawChangeCells(view);
    drawBounds();
    drawScale(view);
  }

  image.addEventListener("load", draw);
  image.addEventListener("error", () => {
    const scaleLabel = document.querySelector("#mapScale");
    if (scaleLabel) scaleLabel.textContent = "EARTH TEXTURE UNAVAILABLE · WGS84 GRATICULE";
    draw();
  });

  canvas.addEventListener("pointerdown", (event) => {
    dragStart = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragStart) return;
    pan = { x: dragStart.panX + event.clientX - dragStart.x, y: dragStart.panY + event.clientY - dragStart.y };
    draw();
  });
  canvas.addEventListener("pointerup", (event) => {
    if (!dragStart) return;
    const movement = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y);
    dragStart = null;
    if (movement < 4) inspectChangeCell(event);
  });
  canvas.addEventListener("pointercancel", () => { dragStart = null; });
  canvas.addEventListener("keydown", (event) => {
    const panStep = width * (event.shiftKey ? 0.2 : 0.05);
    if (event.key === "Enter") {
      event.preventDefault();
      onLocationSelected(center.latitude, center.longitude);
    } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      pan = {
        x: pan.x + (event.key === "ArrowLeft" ? -panStep : event.key === "ArrowRight" ? panStep : 0),
        y: pan.y + (event.key === "ArrowUp" ? -panStep : event.key === "ArrowDown" ? panStep : 0),
      };
      draw();
    }
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoom = Math.max(0.5, Math.min(24, zoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
    draw();
  }, { passive: false });

  return {
    draw,
    fitBounds(nextBounds) {
      bounds = nextBounds;
      center = boundsCenter(bounds);
      pan = { x: 0, y: 0 };
      zoom = 1;
      draw();
    },
    setBounds(nextBounds) { bounds = nextBounds; draw(); },
    setCenter(latitude, longitude) { center = { latitude, longitude }; draw(); },
    setFootprint(nextFootprint) { footprint = nextFootprint; draw(); },
    setChangeCells(nextCells) { changeCells = nextCells ?? []; draw(); },
    setChangeLayerVisible(visible) { changeLayerVisible = visible; draw(); },
    zoom(factor) {
      zoom = Math.max(0.5, Math.min(24, zoom * factor));
      draw();
    },
    dispose() {
      resizeObserver.disconnect();
      image.removeEventListener("load", draw);
      canvas.replaceWith(canvas.cloneNode(false));
    },
  };
}
