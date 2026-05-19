const ngSiteUrl = 'https://www.nationalgallery.org.uk'; 

const exhibitions_api_url = ngSiteUrl + '/umbraco/api/ExhibitionsApi/MediaWallExhibitions';
const event_api_url = ngSiteUrl + '/umbraco/api/EventsApi/TodayInGallery';

const evergreen_url = "evergreen.json";
//MW Adding filler cards reference JSON
const filler_url = "filler.json";

// const totalDuration = 116000; // total duration in ms (e.g., 116000 = 1 mins 56 seconds)
const totalDuration = 30000; // total duration in ms (e.g., 116000 = 20 seconds for testing only)

// MW 19/05/2026: updating max number of pages from 2 to 3 pages and cards to 5
const num_of_pages = 3; // max number of pages
const num_of_cards = 5; // cards per page

const ignoreDates = false; // set to false to ignore past event from today

addEventListener("load", function () {
    async function preloadFonts() {
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
    }

    async function preloadImages(urls) {
        return Promise.all(
            urls.map(
                (url) =>
                    new Promise((resolve) => {
                        const img = new Image();
                        img.onload = resolve;
                        img.onerror = resolve;
                        img.src = url;
                    })
            )
        );
    }
	
	function mapAPIEvent(e) {
	  return {
		fromAPI: true,
		image: e.mediaWallImageUrl,                   
		title: e.title.replace(/\n/g, "<br>"),
		location: e.location.replace(/\n/g, "<br>"),
		cost: e.isFree ? "Free" : "Paid",
		time: formatTime(e.startDt, e.endDt),   
		standFirstCopy: e.standFirstCopy.replace(/\n/g, "<br>")
	  };
	}

	function mapAPIExhibition(e) {
	  return {
		fromAPI: true,
		image: e.imageUrl,                   
		title: e.title.replace(/\n/g, "<br>"),
		location: e.locationCopy.replace(/\n/g, "<br>"),
		cost: e.cost,
		time: e.dateLabel,   
		standFirstCopy: e.standFirstCopy.replace(/\n/g, "<br>"),
		qrCode: e.qrImageUrl,
		cta: e.qrImageCTA.replace(/\n/g, "<br>"),
	  };
	}

    async function getData() {
        const container = document.getElementById("scaled-container");
        const template = document.getElementById("singleEventTemplate");
        const now = new Date();

        // --- 1. Fetch evergreen & filler JSON (local)
        const [evergreenRes] = await Promise.all([
            fetch(evergreen_url).then((r) => r.json())
        ]);
        const evergreenCards = evergreenRes || [];

        const [fillerRes] = await Promise.all([
            fetch(filler_url).then((r) => r.json())
        ]);
        const fillerCards = fillerRes || [];

        // --- 2. Fetch API events
        let upcomingEvents = [];
        try {
            const apiRes = await fetch(event_api_url);
            const data = await apiRes.json();

            let consideredEvents = data.filter((event) => {
                const isUpcoming = new Date(event.endDt) > now;
                const isMember =
                    event.audience &&
                    event.audience.toLowerCase().includes("member");

                //NH addition: filter by status
                const isGoAhead = event.status &&
                    (event.status.toLowerCase() === 'on schedule' ||
                        event.status.toLowerCase() === 'fully booked');

                return isGoAhead && (ignoreDates || isUpcoming) && !isMember;
            });
			upcomingEvents = consideredEvents.map(mapAPIEvent);
        } catch (e) {
            console.warn("API fetch failed, skipping events", e);
        }
		
		// --- 3. Fetch API exhibitions 
		let exhibitionCards = [];
        try {
            const apiRes = await fetch(exhibitions_api_url);
            let consideredExhibitions = await apiRes.json();
			const mappedExh = consideredExhibitions.map(mapAPIExhibition);
			// Move "Free" to the end
			exhibitionCards = [
				...mappedExh.filter(e => !/^free$/i.test(e.cost)),
				...mappedExh.filter(e => /^free$/i.test(e.cost))
			];
        } catch (e) {
            console.warn("API fetch failed, skipping exhibitions", e);
        }
		
        // --- 4. Combine in priority order
        const allEvents = [...exhibitionCards, ...upcomingEvents, ...evergreenCards, ...fillerCards];

        // --- 5. Pagination
        const pages = paginateEvents(allEvents, num_of_cards, num_of_pages);

        // --- 6. Preload images
        const imageUrls = [
            ...exhibitionCards.map((e) => ngSiteUrl + e.image),
            ...upcomingEvents.map((e) => ngSiteUrl + e.image),
            ...evergreenCards.map((e) => e.image),
            ...fillerCards.map((e) => e.image)
        ];
        await Promise.all([preloadImages(imageUrls), preloadFonts()]);

        // --- 7. Start carousel
        runCarousel(pages, container, template, totalDuration, 3000); // 3s delay before first page
    }

    // Break into pages
    function paginateEvents(events, pageSize, pageLimit = Infinity) {
        const pages = [];
        for (let i = 0; i < events.length && pages.length < pageLimit; i += pageSize) {
            const slice = events.slice(i, i + pageSize);
            if (slice.length >= 3) {   // only keep pages with 3 or more items
                pages.push(slice);
            }
        }
        return pages;
    }
	
    // Carousel runner
    function runCarousel(pages, container, template, totalDuration, startDelay = 2000) {
        let currentPage = 0;

        if (pages.length === 0) return; // nothing to show

        // Work out per-page duration
        const pageDuration = totalDuration / pages.length;

        function showPage() {
            renderPage(pages[currentPage], container, template);

            function showNextPage() {
                if (currentPage >= pages.length - 1) {
                    fadeOutAndClear(container);
                    return;
                }
                fadeOutAndRender(pages[++currentPage], container, template);
                setTimeout(showNextPage, pageDuration);
            }

            setTimeout(showNextPage, pageDuration);
        }

        // delay the very first render
        setTimeout(showPage, startDelay);
    }


    function renderPage(events, container, template) {
        container.innerHTML = "";
        events.forEach((event, index) => {
            const clone = template.cloneNode(true);
            clone.style.display = "block";
            container.appendChild(clone);

            if (event.fromAPI) {
				console.log({a: 'this is option 1', event});
                clone.querySelector(".image").src = ngSiteUrl + event.image;
                clone.querySelector(".title").innerHTML = event.title;
                clone.querySelector(".location").innerHTML = event.location;
                clone.querySelector(".cost").innerHTML = event.cost;
                clone.querySelector(".time").innerHTML = event.time;
                clone.querySelector(".standFirstCopy").innerHTML = event.standFirstCopy;
                // Handle optional QR overlay
                if (event.qrCode && event.cta) {
                    const qrOverlay = clone.querySelector(".qr-overlay");
                    qrOverlay.style.display = "flex";
                    qrOverlay.querySelector(".qr-image").src = ngSiteUrl + event.qrCode;
                    qrOverlay.querySelector(".qr-text").innerHTML = event.cta;
                }

            } else {
				console.log({a: 'this is option 2', event});
                clone.querySelector(".image").src = event.image;
                clone.querySelector(".title").innerHTML = event.title.replace(/\n/g, "<br>");
                clone.querySelector(".location").innerHTML = event.location.replace(/\n/g, "<br>");
                clone.querySelector(".cost").innerHTML = event.cost;
                clone.querySelector(".time").innerHTML = event.time;
                clone.querySelector(".standFirstCopy").innerHTML = event.standFirstCopy.replace(/\n/g, "<br>");
                // Handle optional QR overlay
                if (event.qrCode && event.cta) {
                    const qrOverlay = clone.querySelector(".qr-overlay");
                    qrOverlay.style.display = "flex";
                    qrOverlay.querySelector(".qr-image").src = event.qrCode;
                    qrOverlay.querySelector(".qr-text").innerHTML = event.cta.replace(/\n/g, "<br>");
                }
            }
            revealCardWithSlide(clone, index * 600);
        });
    }

    function revealCardWithSlide(element, delay = 0) {
        element.classList.add("card");
        void element.offsetWidth;
        setTimeout(() => {
            element.classList.add("visible");
        }, delay);
    }

    function fadeOutAndRender(events, container, template) {
        [...container.children].forEach((card) => {
            card.classList.remove("visible");
            card.classList.add("fade-out");
        });
        setTimeout(() => {
            container.innerHTML = "";
            renderPage(events, container, template);
        }, 3000);
    }

    function fadeOutAndClear(container) {
        [...container.children].forEach((card) => {
            card.classList.remove("visible");
            card.classList.add("fade-out");
        });
        setTimeout(() => (container.innerHTML = ""), 3000);
    }

    function formatTime(startDt, endDt) {
        const startDate = new Date(startDt);
        const endDate = new Date(endDt);

        function formatParts(date) {
            let hours = date.getHours();
            const minutes = date.getMinutes();
            const ampm = hours >= 12 ? "pm" : "am";
            hours = hours % 12;
            hours = hours ? hours : 12; // midnight or noon fix

            // only show minutes if not :00
            const minStr = minutes !== 0 ? `:${minutes.toString().padStart(2, "0")}` : "";
            return { hours, minStr, ampm };
        }

        const start = formatParts(startDate);
        const end = formatParts(endDate);

        // if same AM/PM, drop from first
        if (start.ampm === end.ampm) {
            return `${start.hours}${start.minStr} – ${end.hours}${end.minStr}${end.ampm}`;
        } else {
            return `${start.hours}${start.minStr}${start.ampm} – ${end.hours}${end.minStr}${end.ampm}`;
        }
    }
    getData();
});
