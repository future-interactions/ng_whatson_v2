/**
 * desk.js
 * Renders the NG Desk Screen HTML from the API JSON data.
 * The JSON data is not modified in any way.
 */

const CAROUSEL_TOTAL_DURATION = 20000; // ms — full loop cycle
const CAROUSEL_MAX_HEIGHT = 1500;      // px — max content per page
const CAROUSEL_CONTAINER_WIDTH = 800;  // px — matches CSS width of .Desk-Content-Block-Container
const CAROUSEL_FADE_DURATION = 800;    // ms — must match CSS transition

let _pendingExhibitionGroups = null;   // set by renderSection(), consumed by init()

/**
 * Fetch and parse the desk data JSON from the given URL.
 */
async function loadDeskData(jsonUrl) {
  const response = await fetch(jsonUrl);
  if (!response.ok) throw new Error(`Failed to load data: ${response.status}`);
  return response.json();
}

/**
 * Build a language tag row from an array of language strings.
 */
function buildLanguages(languages) {
  if (!languages || languages.length === 0) return '';
  const tags = languages
    .map(lang => `<span class="Language">${lang}</span>`)
    .join('');
  return `<div class="Languages"><div class="Languages-row-1">${tags}</div></div>`;
}

/**
 * Build a standard list item (Product + optional languages + optional price).
 */
function buildListItem(item) {
  const langHTML = buildLanguages(item.languages);
  const productName = item.title
    ? `<span class="Product-Name">${item.title}</span>`
    : '';

  const priceHTML = item.cost
    ? `<div class="Price-container"><div class="Price"><span class="Price-text">${item.cost}</span></div></div>`
    : '';

  return `
    <div class="List-Item-Container">
      <div class="Product-and-Languages">
        ${productName}
        ${langHTML}
      </div>
      ${priceHTML}
    </div>`;
}

/**
 * Group exhibition items by their first subheading, preserving sortOrder.
 * Returns an ordered array of { subheading, items } objects.
 */
function groupExhibitionsBySubheading(sectionItems) {
  const ordered = [...sectionItems].sort((a, b) => a.sortOrder - b.sortOrder);
  const subheadingOrder = [];
  const subheadingMap = {};

  ordered.forEach(item => {
    const sh = (item.subheadings && item.subheadings.length > 0) ? item.subheadings[0] : '';
    if (!subheadingMap[sh]) {
      subheadingMap[sh] = [];
      subheadingOrder.push(sh);
    }
    subheadingMap[sh].push(item);
  });

  return subheadingOrder.map(subheading => ({ subheading, items: subheadingMap[subheading] }));
}

/**
 * Build the HTML string for one exhibition group block.
 */
function buildExhibitionBlock(group) {
  const titleHTML = group.subheading
    ? `<span class="Exhibition-title">${group.subheading.replace(/\n/g, '<br/>')}</span>`
    : '';
  const listItemsHTML = group.items.map(buildListItem).join('');
  return `
    <div class="Desk-Content-Block-Container exhibition-carousel-block">
      ${titleHTML}
      ${listItemsHTML}
    </div>`;
}

/**
 * Measure the rendered height of an HTML string at a given width using an off-screen probe.
 */
function measureBlockHeight(htmlString, referenceWidth) {
  const probe = document.createElement('div');
  probe.style.cssText = `position:absolute;visibility:hidden;top:-9999px;left:-9999px;width:${referenceWidth}px;`;
  probe.innerHTML = htmlString;
  document.body.appendChild(probe);
  const el = probe.firstElementChild;
  const h = probe.offsetHeight;
  const marginBottom = el ? parseFloat(getComputedStyle(el).marginBottom) || 0 : 0;
  document.body.removeChild(probe);
  return h + marginBottom;
}

/**
 * Bin-pack exhibition groups into pages based on measured heights.
 * A new page starts only when adding the next group would exceed maxHeight
 * AND the current page already has content.
 */
function paginateExhibitionGroups(groups, maxHeight, containerWidth) {
  const pages = [];
  let currentPage = [];
  let currentHeight = 0;

  for (const group of groups) {
    const html = buildExhibitionBlock(group);
    const h = measureBlockHeight(html, containerWidth);

    if (currentPage.length > 0 && currentHeight + h > maxHeight) {
      pages.push(currentPage);
      currentPage = [];
      currentHeight = 0;
    }

    currentPage.push(group);
    currentHeight += h;
  }

  if (currentPage.length > 0) {
    pages.push(currentPage);
  }

  return pages;
}

/**
 * Build membership product items.
 */
function buildMembershipItem(item) {
  const descHTML = item.description ? item.description : '';
  const priceHTML = item.cost
    ? `<div class="Membership-price-container"><span class="Membership-price-text">${item.cost}</span></div>`
    : '';

  return `
    <div class="Membership-product-container">
      <div class="Membership-product-text">
        <div class="Membership-product-title">${item.title}</div>
        <div class="Membership-product-details">${descHTML}</div>
      </div>
      ${priceHTML}
    </div>`;
}

/**
 * Render a single section.
 * A section is a group of items sharing the same sectionOrder within an area.
 */
function renderSection(sectionItems) {
  if (sectionItems.length === 0) return '';

  const first = sectionItems[0];
  const contentType = first.contentType;

  // --- MEMBERSHIP section ---
  if (contentType === 'membership') {
    const subtitleHTML = first.sectionSubtitle
      ? `<div class="Membership-Subtitle"><div class="Product-and-Languages"><span class="Product-Name">${stripTags(first.sectionSubtitle)}</span></div></div>`
      : '';

    const itemsHTML = sectionItems
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(buildMembershipItem)
      .join('');

    return `
    <div class="Desk-Content-Block-Membership-Container">
      <span class="Section-Title">${first.sectionTitle}</span>
      ${subtitleHTML}
      <div class="Membership-product-list">
        ${itemsHTML}
      </div>
    </div>`;
  }

  // --- INFO EXHIBITION section ---
  // Emits the header block and a carousel placeholder; the carousel runtime
  // fills the placeholder after the DOM is injected (see init()).
  if (contentType === 'info exhibition') {
    const subtitleText = first.sectionSubtitle ? stripTags(first.sectionSubtitle) : '';
    const headerBlock = `
    <div class="Desk-Content-Block-Container">
      <span class="Section-Title">${first.sectionTitle}</span>
      ${subtitleText ? `<div class="List-Item-Container"><div class="Product-and-Languages"><span class="Product-Name">${subtitleText}</span></div></div>` : ''}
    </div>`;

    _pendingExhibitionGroups = groupExhibitionsBySubheading(sectionItems);

    return headerBlock + `
    <div id="story-progress-bar" style="display:none;"></div>
    <div id="exhibition-carousel-container"></div>`;
  }

  // --- INFO CONTENT section (default) ---
  const subtitleText = first.sectionSubtitle ? stripTags(first.sectionSubtitle) : '';
  const subtitleItem = subtitleText
    ? `<div class="List-Item-Container"><div class="Product-and-Languages"><span class="Product-Name">${subtitleText}</span></div></div>`
    : '';

  const itemsHTML = sectionItems
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(item => {
      // Items with no title but a subtitle-only entry (e.g. Events)
      if (!item.title) return subtitleItem; // subtitle-only items are shown via the hasNoTitledItems path below
      return buildListItem(item);
    })
    .join('');

  // Events-style: no title items — subtitle serves as the body text
  // Handled by buildListItem returning empty product name; the subtitle line
  // is emitted as the subtitle item above.
  const hasNoTitledItems = sectionItems.every(i => !i.title);

  return `
    <div class="Desk-Content-Block-Container">
      <span class="Section-Title">${first.sectionTitle}</span>
      ${hasNoTitledItems ? subtitleItem : itemsHTML}
    </div>`;
}

/**
 * Strip HTML tags to get plain text content.
 */
function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').trim();
}

/**
 * Main render function.
 * Takes the raw JSON array and returns the complete desk screen HTML string.
 */
function renderDeskScreen(data) {
  // Separate items into left and right columns
  const left = data.filter(item => item.position === 'left');
  const right = data.filter(item => item.position === 'right');

  function renderColumn(items) {
    // Sort by areaOrder, then sectionOrder, then sortOrder
    items.sort((a, b) =>
      a.areaOrder - b.areaOrder ||
      a.sectionOrder - b.sectionOrder ||
      a.sortOrder - b.sortOrder
    );

    // Group by areaOrder + sectionOrder key
    const sectionMap = new Map();
    items.forEach(item => {
      const key = `${item.areaOrder}__${item.sectionOrder}`;
      if (!sectionMap.has(key)) sectionMap.set(key, []);
      sectionMap.get(key).push(item);
    });

    let html = '';
    sectionMap.forEach(sectionItems => {
      html += renderSection(sectionItems);
    });
    return html;
  }

  const leftHTML = renderColumn(left);
  const rightHTML = renderColumn(right);

  return `
<div class="Desk-Screen">
  <div class="Desk-Content-Left-Column">
    ${leftHTML}
  </div>
  <div class="Desk-Content-Right-Column">
    ${rightHTML}
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Progress bar helpers (ported from NG Desk screen scrolling/script.js)
// ---------------------------------------------------------------------------
function buildProgressBar(pageCount) {
  const bar = document.getElementById('story-progress-bar');
  if (!bar) return;
  bar.style.display = pageCount > 1 ? 'flex' : 'none';
  bar.innerHTML = Array.from({ length: pageCount }, (_, i) =>
    `<div class="story-segment" id="seg-${i}">
       <div class="story-segment-fill" id="seg-fill-${i}"></div>
     </div>`
  ).join('');
}

function updateProgressBar(activeIndex, duration) {
  document.querySelectorAll('.story-segment-fill').forEach((fill, i) => {
    if (i < activeIndex) {
      fill.style.transition = 'none';
      fill.style.width = '100%';
    } else if (i === activeIndex) {
      fill.style.transition = 'none';
      fill.style.width = '0%';
      void fill.offsetWidth; // force reflow so animation fires from 0
      fill.style.transition = `width ${duration}ms linear`;
      fill.style.width = '100%';
    } else {
      fill.style.transition = 'none';
      fill.style.width = '0%';
    }
  });
}

function resetProgressBar() {
  document.querySelectorAll('.story-segment-fill').forEach(fill => {
    fill.style.transition = 'none';
    fill.style.width = '0%';
  });
}

// ---------------------------------------------------------------------------
// Carousel page render helpers
// ---------------------------------------------------------------------------
function renderCarouselPage(groups, container) {
  container.innerHTML = groups.map(buildExhibitionBlock).join('');
}

function fadeOutAndRenderCarousel(groups, container, callback) {
  container.classList.add('fade-out');
  setTimeout(() => {
    container.innerHTML = '';
    renderCarouselPage(groups, container);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.classList.remove('fade-out');
        if (typeof callback === 'function') callback();
      });
    });
  }, CAROUSEL_FADE_DURATION);
}

// ---------------------------------------------------------------------------
// Main exhibition carousel loop
// ---------------------------------------------------------------------------
function runExhibitionCarousel(pages) {
  if (pages.length === 0) return;

  const container = document.getElementById('exhibition-carousel-container');
  if (!container) return;

  const pageDuration = CAROUSEL_TOTAL_DURATION / pages.length;
  let currentPage = 0;

  buildProgressBar(pages.length);

  if (pages.length === 1) {
    renderCarouselPage(pages[0], container);
    return;
  }

  function showPage() {
    renderCarouselPage(pages[currentPage], container);
    updateProgressBar(currentPage, pageDuration);
    setTimeout(advance, pageDuration);
  }

  function advance() {
    const nextPage = (currentPage + 1) % pages.length;
    if (nextPage === 0) resetProgressBar();

    fadeOutAndRenderCarousel(pages[nextPage], container, () => {
      currentPage = nextPage;
      updateProgressBar(currentPage, pageDuration);
      setTimeout(advance, pageDuration);
    });
  }

  setTimeout(showPage, 500);
}

/**
 * Initialise: load JSON and inject rendered HTML into the page.
 * Called on DOMContentLoaded.
 */
async function init() {
  try {
    const data = await loadDeskData('3page.json');
    const html = renderDeskScreen(data);         // populates _pendingExhibitionGroups
    document.getElementById('desk-root').innerHTML = html;

    // Wait for fonts to load so height probing is accurate
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    if (_pendingExhibitionGroups && _pendingExhibitionGroups.length > 0) {
      const pages = paginateExhibitionGroups(
        _pendingExhibitionGroups,
        CAROUSEL_MAX_HEIGHT,
        CAROUSEL_CONTAINER_WIDTH
      );
      runExhibitionCarousel(pages);
      _pendingExhibitionGroups = null;
    }
  } catch (err) {
    console.error('Desk render error:', err);
    document.getElementById('desk-root').innerHTML =
      `<p style="color:red">Failed to load desk data: ${err.message}</p>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
