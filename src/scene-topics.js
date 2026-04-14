/**
 * 3D Topic control panel — checkboxes to enable/disable foxglove topics in the 3D scene.
 */

const TOPIC_GROUPS = {
  'Trajectory': ['/ego_line', '/target_line', '/ego_left', '/ego_right'],
  'Obstacles': ['/obj_infer_3d', '/prediction_3d'],
  'Map': ['/maps_3d', '/hd_map', '/lite_map', '/router_output_3d', '/router_output_lanes', '/static_3d', '/map_tr_infer'],
  'Perception': ['/lidar_freespace', '/occ_infer', '/lane_seg', '/occ_fusion', '/occ_status'],
  'Planning': ['/planning/monitor_3d', '/ego_car', '/perception_obstacle', '/plane'],
  'Position': ['/fix/', '/poses_in_frame', '/trajectory'],
};

function categorize(topic) {
  for (const [group, patterns] of Object.entries(TOPIC_GROUPS)) {
    for (const pat of patterns) {
      if (topic.includes(pat)) return group;
    }
  }
  return 'Other';
}

const TOPIC_COLORS = {};
const PALETTE = ['#10b981','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#ec4899','#06b6d4','#6b8f8f','#d4884d','#777'];
let colorIdx = 0;
function getTopicColor(topic) {
  if (!TOPIC_COLORS[topic]) {
    TOPIC_COLORS[topic] = PALETTE[colorIdx % PALETTE.length];
    colorIdx++;
  }
  return TOPIC_COLORS[topic];
}

/**
 * @param {HTMLElement} container
 * @param {Array} foxgloveChannels — mcap channels with foxglove schemas
 * @param {function} onToggle — (topic, enabled) callback
 */
export function createSceneTopics(container, foxgloveChannels, onToggle) {
  const el = document.createElement('div');
  el.className = 'st-panel';

  el.innerHTML = `
    <div class="st-header">
      <span class="st-title">3D Topics</span>
      <span class="st-count">${foxgloveChannels.length}</span>
    </div>
    <div class="st-list" id="st-list"></div>
  `;
  container.appendChild(el);

  const listEl = el.querySelector('#st-list');

  // Group channels by category
  const grouped = {};
  for (const ch of foxgloveChannels) {
    const cat = categorize(ch.topic);
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(ch);
  }

  // Default enabled topics (key scene elements)
  const defaultEnabled = new Set();
  for (const ch of foxgloveChannels) {
    if (ch.topic.includes('ego_line') || ch.topic.includes('obj_infer_3d') ||
        ch.topic.includes('maps_3d/hd_map') || ch.topic.includes('router_output_3d') ||
        ch.topic.includes('static_3d') || ch.topic.includes('ego_car') ||
        ch.topic.includes('prediction_3d') || ch.topic.includes('target_line')) {
      defaultEnabled.add(ch.topic);
    }
  }

  const enabledSet = new Set(defaultEnabled);

  for (const [cat, channels] of Object.entries(grouped).sort()) {
    const groupEl = document.createElement('div');
    groupEl.className = 'st-group';
    groupEl.innerHTML = `<div class="st-group-name">${esc(cat)}</div>`;

    for (const ch of channels) {
      const color = getTopicColor(ch.topic);
      const checked = enabledSet.has(ch.topic) ? 'checked' : '';
      const item = document.createElement('label');
      item.className = 'st-item';
      item.innerHTML = `
        <input type="checkbox" ${checked} data-topic="${escAttr(ch.topic)}" />
        <span class="st-color" style="background:${color}"></span>
        <span class="st-topic">${esc(shortTopic(ch.topic))}</span>
        <span class="st-schema">${esc(ch.schemaName.replace('foxglove.', ''))}</span>
      `;
      item.querySelector('input').addEventListener('change', (e) => {
        const topic = e.target.dataset.topic;
        if (e.target.checked) {
          enabledSet.add(topic);
          onToggle(topic, true);
        } else {
          enabledSet.delete(topic);
          onToggle(topic, false);
        }
      });
      groupEl.appendChild(item);
    }
    listEl.appendChild(groupEl);
  }

  // Fire initial state
  for (const topic of enabledSet) {
    onToggle(topic, true);
  }

  function getEnabled() { return [...enabledSet]; }
  function destroy() { el.remove(); }

  return { getEnabled, destroy };
}

function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return s.replace(/"/g, '&quot;'); }
function shortTopic(t) { const parts = t.split('/').filter(Boolean); return parts.length > 1 ? '/' + parts.slice(-2).join('/') : t; }
