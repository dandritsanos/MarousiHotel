// ========== Footer Animation ==========
document.addEventListener('DOMContentLoaded', () => {
  const footer = document.querySelector('.footer');
  window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
      footer?.classList.add('footer-visible');
    } else {
      footer?.classList.remove('footer-visible');
    }
  });
  const navbar   = document.querySelector('.navbar');
    const toggle   = document.querySelector('.menu-toggle');
    const drawer   = document.getElementById('primaryNav');
    const closeBtn = document.querySelector('.drawer-close');
    const backdrop = document.getElementById('navBackdrop');
    if (!navbar || !toggle || !drawer) return;

    const isDesktop = () => window.matchMedia('(min-width:701px)').matches;

    function setDesktop(){
      // desktop: inline nav, no drawer behavior
      navbar.classList.remove('open');
      document.body.classList.remove('no-scroll');
      drawer.removeAttribute('inert');
      drawer.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'false');
      if (backdrop) backdrop.hidden = true;
    }
    function setMobileInitial(){
      // mobile: start closed
      drawer.setAttribute('aria-hidden', 'true');
      drawer.setAttribute('inert', '');
      toggle.setAttribute('aria-expanded', 'false');
      if (backdrop) backdrop.hidden = true;
    }

    function openMenu(){
      if (isDesktop()) return;
      navbar.classList.add('open');
      document.body.classList.add('no-scroll');
      drawer.removeAttribute('inert');
      drawer.setAttribute('aria-hidden', 'false');
      toggle.setAttribute('aria-expanded', 'true');
      if (backdrop) backdrop.hidden = false;
      (closeBtn || drawer.querySelector('a,button,[tabindex]:not([tabindex="-1"])'))?.focus?.();
    }

    function closeMenu(){
      if (isDesktop()) return;
      if (drawer.contains(document.activeElement)) toggle.focus();
      navbar.classList.remove('open');
      document.body.classList.remove('no-scroll');
      drawer.setAttribute('aria-hidden', 'true');
      drawer.setAttribute('inert', '');
      toggle.setAttribute('aria-expanded', 'false');
      if (backdrop) backdrop.hidden = true;
    }

    // initial mode
    (isDesktop() ? setDesktop : setMobileInitial)();

    // toggle button
    toggle.addEventListener('click', () => {
      if (isDesktop()) { setDesktop(); return; }
      navbar.classList.contains('open') ? closeMenu() : openMenu();
    });

    // esc & outside-click: mobile only
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !isDesktop()) closeMenu();
    });
    document.addEventListener('pointerdown', e => {
      if (isDesktop() || !navbar.classList.contains('open')) return;
      if (!drawer.contains(e.target) && !toggle.contains(e.target)) closeMenu();
    });
    closeBtn?.addEventListener('click', closeMenu);

    // respond to resize
    const mq = window.matchMedia('(min-width:701px)');
    mq.addEventListener('change', e => e.matches ? setDesktop() : setMobileInitial());

     const current = location.pathname.split('/').pop() || 'index.html';
   document.querySelectorAll('#primaryNav > a, header .nav-links > a').forEach(a => {
    const href = (a.getAttribute('href') || '').split('#')[0].toLowerCase();
    if (href === current) {
      a.classList.add('active');
      a.setAttribute('aria-current', 'page');
    } else {
      a.classList.remove('active');
      a.removeAttribute('aria-current');
    }
  });
});

// ========== XSS Prevention ==========
const cleanInput = (text) => text.replace(/<[^>]*>?/gm, '');

// ========== Globals ==========
let currentPrices = {};
let maxGuestsAllowed = 1;
let slideImages = [];
let currentSlideIndex = 0;
// removed: isPhoneVerified
let allowedRoomTypes = ["Economy Room", "Deluxe Room", "Single Room", "Double Room"];
let nextRoomId = 2;
let rooms = [{ id: 1, adults: 1, children: 0, type: "Deluxe Room", infantUnder2: false }];

// DOM refs
const modal = document.getElementById("roomModal");
const modalTitle = document.getElementById("modalTitle");
const modalDescription = document.getElementById("modalDescription");
const modalPrice = document.getElementById("modalPrice");
const closeBtn = document.querySelector(".modal-close");
const modalSlidesContainer = document.querySelector(".modal-slides");
const prevBtn = document.querySelector(".modal-prev");
const nextBtn = document.querySelector(".modal-next");
const roomCards = document.querySelectorAll(".room-card");
const lightboxOverlay = document.getElementById("lightboxOverlay");
const lightboxImage = document.getElementById("lightboxImage");
const bookingBtn = document.querySelector(".book-btn");
const bookingForm = document.getElementById("bookingForm");
const summaryText = document.getElementById('summaryText');
const guestToggle = document.getElementById('guestToggle');
const guestPanel = document.getElementById('guestPanel');
const roomsContainer = document.getElementById('roomsContainer');
const HAS_BOOKING_UI = !!document.getElementById('orderSummary');
const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
const setVal  = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };

// ========== Helper Functions ==========

function showSlide(index) {
  const slides = modalSlidesContainer.querySelectorAll("img");
  slides.forEach((img, i) => {
    img.classList.toggle("active", i === index);
  });
}

function getNights(checkin, checkout) {
  if (!checkin || !checkout) return 0;
  const inDate = new Date(checkin);
  const outDate = new Date(checkout);
  const diff = (outDate - inDate) / (1000 * 60 * 60 * 24);
  return diff > 0 ? diff : 0;
}

// --- helper: how many guests should we charge for? (infant doesn't count)
function getChargeableGuests(room) {
  const n = room.adults + room.children - (room.infantUnder2 ? 1 : 0);
  return Math.max(1, n); // never below 1
}

function getRoomPricePerNight(room) {
  const card = Array.from(document.querySelectorAll('.room-card'))
    .find(c => c.dataset.title === room.type);
  if (!card) return 0;

  const prices = JSON.parse(card.dataset.prices || '{}');
  let guests = getChargeableGuests(room);        // <-- use chargeable guests

  while (guests > 0 && !prices[guests]) guests--;
  return prices[guests] || 0;
}

function roomTypeSummary(rooms) {
  let counts = {};
  rooms.forEach(r => {
    counts[r.type] = (counts[r.type] || 0) + 1;
  });
  return Object.entries(counts).map(([type, count]) =>
    count > 1 ? `${type} x${count}` : type
  ).join(', ');
}

function updateGuestsLabel() {
  const label = document.querySelector('label[for="guests"]');
  if (label) {
    label.textContent = `Guests (Up to ${maxGuestsAllowed})`;
  }
}

function updateRoomTitles() {
  const roomElements = document.querySelectorAll('.room');
  roomElements.forEach((roomEl, index) => {
    const titleEl = roomEl.querySelector('.guest-toggle-room-title');
    if (titleEl) titleEl.textContent = `Room ${index + 1}`;
  });
}

function updateSummary() {
  if (!HAS_BOOKING_UI) return;
  const roomCount = rooms.length;
  let totalAdults = 0, totalChildren = 0;
  rooms.forEach(r => {
    totalAdults += r.adults;
    totalChildren += r.children;
  });
  let text = `${roomCount} Room${roomCount > 1 ? 's' : ''} | ${totalAdults} Adult${totalAdults > 1 ? 's' : ''}`;
  if (totalChildren > 0) text += `, ${totalChildren} Child${totalChildren > 1 ? 'ren' : ''}`;
   if (summaryText) summaryText.textContent = text;  // <-- guard
  if (guestToggle) guestToggle.textContent = text;  // <-- guard
}

function resetRoomSelectionToDefault() {
  rooms = [{ id: 1, adults: 1, children: 0, type: allowedRoomTypes[0], infantUnder2: false }];
  nextRoomId = 2;
  const roomTypeOptions = allowedRoomTypes.map(type =>
    `<option value="${type}" ${type === allowedRoomTypes[0] ? 'selected' : ''}>${type.replace(" Room", "")}</option>`
  ).join("");
  roomsContainer.innerHTML = `
    <div class="room room-block" data-room="1" id="room-1" style="padding: 0.5rem;">
      <div style="position: relative; text-align: center; margin-bottom: 0.5rem;">
        <h4 class="guest-toggle-room-title" style="margin: 0; font-weight: 600; font-size: 1rem;">Room 1</h4>
      </div>
      <div class="guest-row">
        <span>Room Type</span>
        <select class="room-type-select" data-room="1" id="room-type-1" style="padding: 4px 13px; border-radius: 6px;">
          ${roomTypeOptions}
        </select>
      </div>
      <div class="guest-row">
        <span>Adults (18+)</span>
        <div>
          <button type="button" class="minus" data-room="1" data-type="adults" style="width: 32px;">–</button>
          <span id="adults-1" style="margin: 0 10px;">1</span>
          <button type="button" class="plus" data-room="1" data-type="adults" style="width: 32px;">+</button>
        </div>
      </div>
      <div class="guest-row">
        <span>Children</span>
        <div>
          <button type="button" class="minus" data-room="1" data-type="children" style="width: 32px;">–</button>
          <span id="children-1" style="margin: 0 10px;">0</span>
          <button type="button" class="plus" data-room="1" data-type="children" style="width: 32px;">+</button>
        </div>
      </div>
      <div class="guest-row infant-row">
        <span class="label">Infant (under 2)</span>
        <div class="control">
          <input type="checkbox" class="infant-checkbox" data-room="1" aria-label="Infant (under 2)">
        </div>
      </div>
    </div>
  `;
  if (!document.getElementById('addRoom')) {
    const addRoomHTML = `<button id="addRoom" type="button" style="margin-top: 10px; background: none; border: none; font-weight: bold;">+ Add Another Room</button>`;
    roomsContainer.insertAdjacentHTML('afterend', addRoomHTML);
    document.getElementById('addRoom').addEventListener('click', addRoomHandler);
  }
  const roomLimitMsg = document.getElementById('roomLimitMsg');
  if (roomLimitMsg) roomLimitMsg.remove();

  // reset word count UI safely
  if (typeof wordCountDisplay !== 'undefined' && wordCountDisplay) {
    wordCountDisplay.textContent = "Words: 0 / 500";
    wordCountDisplay.style.display = "none";
  }

  const formElement = bookingForm.querySelector("form");
  formElement.reset();
  resetDates();
  bindControls();
  rooms.forEach(r => setInfantVisibility(r.id));
  updateSummary();
  updateRoomTitles();
  updateOrderSummary();
  resetPhoneCountryCodeToDefault();
}
function updateOrderSummary() {
  if (!HAS_BOOKING_UI) return;

  const checkin  = document.getElementById('checkin')?.value || '';
  const checkout = document.getElementById('checkout')?.value || '';
  const nights   = getNights(checkin, checkout);

  let totalAdults = 0, totalChildren = 0, pricePerNight = 0, infants = 0;

  rooms.forEach(room => {
    totalAdults   += room.adults;
    totalChildren += room.children;
    if (room.infantUnder2) infants += 1;
    pricePerNight += getRoomPricePerNight(room);
  });

  // Guests text (e.g., "2 Adults, 1 Child (1 Infant)")
  let guestsText = `${totalAdults} Adult${totalAdults !== 1 ? 's' : ''}`;
  if (totalChildren > 0) guestsText += `, ${totalChildren} Child${totalChildren !== 1 ? 'ren' : ''}`;
  if (infants > 0)       guestsText += ` (${infants} Infant${infants > 1 ? 's' : ''})`;
  const roomTypes = roomTypeSummary(rooms);

  // Visible summary
  setText('osRoom',     roomTypes || '-');
  setText('osGuests',   guestsText || '-');
  setText('osCheckin',  checkin || '-');
  setText('osCheckout', checkout || '-');
  setText('osNights',   nights);
  setText('osPrice',    pricePerNight ? `€${pricePerNight}` : '-');

  // Pricing
  const taxPerNight = 2 * rooms.length; // €2/night per room
  const totalPrice  = (pricePerNight + taxPerNight) * nights;

  setText(
    'osTotal',
    (nights && pricePerNight)
      ? `Total Price €${totalPrice.toFixed(2)} for ${nights} Night${nights !== 1 ? 's' : ''}`
      : '-'
  );

  // Hidden fields (what the server emails)
  setVal('roomType',      roomTypes);                          // overwrite single title with multi-room summary
  setVal('roomPrice',     pricePerNight || '');
  setVal('guests',        String(totalAdults + totalChildren));
  setVal('guestsText',    guestsText || '');
  setVal('nights',        String(nights || ''));
  setVal('infants',       String(infants || 0));
  setVal('roomBreakdown', JSON.stringify(rooms));              // [{id,type,adults,children,infantUnder2}, ...]
  setVal('total',         (nights && pricePerNight) ? totalPrice.toFixed(2) : '');

  // UI toggles
  const hasDates = !!(checkin && checkout && nights > 0);
  document.getElementById('orderSummary').style.display = hasDates ? 'block' : 'none';
  document.getElementById('formSummaryBridge')?.classList.toggle('visible', hasDates);

  const submitBtn = document.getElementById('submitBtn');
  if (submitBtn) submitBtn.style.display = hasDates ? 'inline-block' : 'none';
}


function isBookingReady() {
  const firstName = document.getElementById('firstName')?.value.trim();
  const lastName = document.getElementById('lastName')?.value.trim();
  const email = document.getElementById('email')?.value.trim();
  const phone = document.getElementById('phone')?.value.trim();
  const checkin = document.getElementById('checkin')?.value;
  const checkout = document.getElementById('checkout')?.value;
  const guests = document.getElementById('guests')?.value;
  return firstName && lastName && email && phone && checkin && checkout && guests;
}

function handleBookingInput() {
  updateOrderSummary();

  const checkin  = document.getElementById('checkin')?.value;
  const checkout = document.getElementById('checkout')?.value;
  const hasDates = !!(checkin && checkout && getNights(checkin, checkout) > 0);

  const submitBtn = document.getElementById('submitBtn');
  if (submitBtn) submitBtn.style.display = hasDates ? 'inline-block' : 'none';
}

// ========== Event Bindings ==========
function updateGuestsLabel() {
  const label = document.querySelector('label[for="guestToggle"]');
  if (label) label.textContent = `Guests`;
}
document.addEventListener('DOMContentLoaded', () => {

  if (window.AOS) {
  AOS.init({
    duration: 600,
    once: false,    // animate every time it enters the viewport
    mirror: true,   // (optional) animate out when scrolling past, then back in
    offset: 80,
    easing: 'ease-out',
  });
}
  
  // --- Guests panel open/close ---
(function setupGuestPanel() {
  const toggle = document.getElementById('guestToggle');
  const panel  = document.getElementById('guestPanel');
  if (!toggle || !panel) return;

  const open  = () => { panel.style.display = 'block'; toggle.classList.add('active'); toggle.setAttribute('aria-expanded','true'); };
  const close = () => { panel.style.display = 'none';  toggle.classList.remove('active'); toggle.setAttribute('aria-expanded','false'); };

  // Click the pill
  toggle.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  // Keyboard access
  toggle.setAttribute('tabindex','0');
  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
  // Clicking the floating label should also open
  document.querySelector('label[for="guestToggle"]')
    ?.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(); });

  // “Update” closes the panel
  document.getElementById('updateGuests')
    ?.addEventListener('click', () => close());

  // Click outside closes
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && !toggle.contains(e.target)) close();
  });

  console.log('[Guests] handlers ready');
})();

  // --- Modal logic ---
  roomCards.forEach(card => {
    card.addEventListener("click", () => {
      const guestsInput = document.getElementById('guests');
      guestsInput.value = 1;
      handleBookingInput();
      modalTitle.textContent = card.dataset.title;
      modalDescription.textContent = card.dataset.description;
      modalPrice.textContent = card.dataset.price;
      allowedRoomTypes = JSON.parse(card.dataset.roomtypes || '["Economy Room", "Deluxe Room", "Single Room", "Double Room"]');
      resetRoomSelectionToDefault();
      document.getElementById('roomType').value = card.dataset.title;
      currentPrices = JSON.parse(card.dataset.prices || "{}");
      maxGuestsAllowed = Math.max(...Object.keys(currentPrices).map(Number));
      updateGuestsLabel();
      guestsInput.setAttribute('max', maxGuestsAllowed);
      modalSlidesContainer.innerHTML = "";
      slideImages = JSON.parse(card.dataset.images || "[]");
      slideImages.forEach((src, i) => {
        const img = document.createElement("img");
        img.src = src;
        img.alt = card.dataset.title;
        if (i === 0) img.classList.add("active");
        modalSlidesContainer.appendChild(img);
      });
      currentSlideIndex = 0;
      showSlide(currentSlideIndex);
      modal.style.display = "flex";
      updateOrderSummary();
      requestAnimationFrame(scrollToBookingButton);
    });
  });

  prevBtn?.addEventListener("click", e => {
    e.stopPropagation();
    currentSlideIndex = (currentSlideIndex - 1 + slideImages.length) % slideImages.length;
    showSlide(currentSlideIndex);
  });
  nextBtn?.addEventListener("click", e => {
    e.stopPropagation();
    currentSlideIndex = (currentSlideIndex + 1) % slideImages.length;
    showSlide(currentSlideIndex);
  });
  closeBtn?.addEventListener("click", () => {
    if (!modalProgress?.hidden && modalProgress.getAttribute('aria-busy') === 'true') return;
    closeModalAndResetForm();
  });

  modal?.addEventListener("click", (e) => {
    if (e.target !== modal) return;
    if (!modalProgress?.hidden && modalProgress.getAttribute('aria-busy') === 'true') return;
    closeModalAndResetForm();
  });

  // --- Flatpickr Setup ---
  const initDatePicker = () => {
    const dateInput = document.getElementById('dates');
    if (!dateInput || dateInput._flatpickr) return;
    flatpickr("#dates", {
      mode: "range",
      minDate: "today",
      dateFormat: "D, d M",
      position: "below",
      static: true,
      monthSelectorType: 'static',
      showMonths: 1,
      locale: {
        weekdays: {
          shorthand: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
          longhand: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        },
        months: {
          shorthand: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
          longhand: [
            'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December',
          ],
        },
        firstDayOfWeek: 1
      },
      onOpen(selectedDates, dateStr, instance) {
        if (instance.selectedDates.length === 0) {
          instance.setDate([new Date()], false);
          instance._input.value = "";
        }
      },
      onChange(selectedDates, dateStr, instance) {
        if (selectedDates.length === 2) {
          const checkin = selectedDates[0];
          const checkout = selectedDates[1];
          document.getElementById('checkin').value = instance.formatDate(checkin, "Y-m-d");
          document.getElementById('checkout').value = instance.formatDate(checkout, "Y-m-d");
          instance.element.value = `${instance.formatDate(checkin, "D, d M")} - ${instance.formatDate(checkout, "D, d M")}`;
          instance._input.blur();
          handleBookingInput();
        }
      },
      onClose: function() {
        if (!this.input.value) this.clear();
      }
    });
  };
  initDatePicker();

  // --- Booking Button ---
  if (bookingBtn && bookingForm) {
    const formElement = bookingForm.querySelector("form");
    bookingBtn.addEventListener("click", function (e) {
      e.preventDefault();
      const isVisible = bookingForm.style.display === "block";
      if (isVisible) {
        bookingForm.style.display = "none";
        bookingBtn.textContent = "Booking Request";
        resetRoomSelectionToDefault();
      } else {
        bookingForm.style.display = "block";
        bookingBtn.textContent = "Cancel Booking Request";
        bookingForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    
  }

  // --- Set today's min date for inputs ---
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('checkin')?.setAttribute('min', today);
  document.getElementById('checkout')?.setAttribute('min', today);

  // --- Order Summary Inputs Binding ---
  ['roomType', 'guests', 'checkin', 'checkout'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateOrderSummary);
  });

  // --- Booking Fields ---
  ['firstName', 'lastName', 'email', 'phone', 'checkin', 'checkout', 'guests'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', handleBookingInput);
  });
  document.getElementById('dates')?.addEventListener('input', handleBookingInput);

  // --- Image Lightbox ---
  modalSlidesContainer?.addEventListener("click", e => {
    if (e.target.tagName === "IMG") {
      lightboxImage.src = e.target.src;
      lightboxOverlay.style.display = "flex";
    }
  });
  lightboxOverlay?.addEventListener("click", () => {
    lightboxOverlay.style.display = "none";
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") lightboxOverlay.style.display = "none";
  });

  // --- Room Management Controls ---
  bindControls();
  rooms.forEach(r => setInfantVisibility(r.id));
  if (HAS_BOOKING_UI) {
    updateSummary();
    updateRoomTitles();
    updateOrderSummary();
  }
  
  document.getElementById('addRoom')?.addEventListener('click', addRoomHandler);
  roomsContainer?.addEventListener('click', function (e) {
    if (e.target.classList.contains('remove-room-btn')) {
      e.stopPropagation();
      const roomNum = parseInt(e.target.dataset.room, 10);
      const roomEl = document.getElementById(`room-${roomNum}`);
      if (roomEl) {
        roomEl.remove();
        rooms = rooms.filter(r => r.id !== roomNum);
        updateSummary();
        updateRoomTitles();
        updateOrderSummary();
        if (rooms.length < 2 && !document.getElementById('addRoom')) {
          const roomLimitMsg = document.getElementById('roomLimitMsg');
          if (roomLimitMsg) roomLimitMsg.remove();
          const addRoomHTML = `<button id="addRoom" type="button" style="margin-top: 10px; background: none; border: none; font-weight: bold;">+ Add Another Room</button>`;
          roomsContainer.insertAdjacentHTML('afterend', addRoomHTML);
          document.getElementById('addRoom').addEventListener('click', addRoomHandler);
        }
      }
    }
  });

  // ---- Booking Form Submit (no OTP gating) ----
  document.getElementById('bookingFormHTML')?.addEventListener('submit', async function (e) {
    e.preventDefault();

    const firstName = cleanInput(document.getElementById('firstName').value);
    const lastName = cleanInput(document.getElementById('lastName').value);
    const email = cleanInput(document.getElementById('email').value);
    const phoneRaw = cleanInput(document.getElementById('phone').value);
    const countryCodeFull = document.getElementById('countryCode').value || "+30";
    const phone = countryCodeFull.match(/\+[\d]+/)?.[0] + phoneRaw;
    const message = cleanInput(document.getElementById('message').value);

    if (!validateBookingForm()) return;
    showModalLoading('Sending your request…', 'This usually only takes a few seconds.');

    const formData = {
      roomType:      document.getElementById('roomType').value,
      name:          `${firstName} ${lastName}`,
      email,
      phone,
      checkin:       document.getElementById('checkin').value,
      checkout:      document.getElementById('checkout').value,
      guests:        document.getElementById('guests').value,
      guestsText:    document.getElementById('guestsText').value,
      pricePerNight: document.getElementById('roomPrice').value,
      nights:        document.getElementById('nights').value,
      infants:       document.getElementById('infants').value,
      roomBreakdown: document.getElementById('roomBreakdown').value,
      message,
      captchaToken:  document.getElementById('captchaToken').value.trim()
    };

    const submitBtn = document.getElementById('submitBtn');
    if (submitBtn) submitBtn.disabled = true;

    try {
      const response = await fetch('/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(formData)
      });
      if (!response.ok) throw new Error('Server responded with status ' + response.status);
      const result = await response.json();
      showModalResult('success', result.message || 'Your request has been sent.');

      // Reset UI & state
      if (submitBtn) submitBtn.style.display = 'none';
      document.getElementById('orderSummary').style.display = 'none';
    } catch (error) {
       showModalResult('error', 'Our booking service is currently unavailable. Please try again.');
      console.error('Booking submission error:', error);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
});

// ========== Functions outside DOMContentLoaded ==========

function resetDates() {
  const dateInput = document.getElementById('dates');
  if (!dateInput) return;
  const fp = dateInput._flatpickr;
  if (fp) {
    fp.clear();
    fp.setDate(null, false);
    fp.input.value = "";
    fp.input.placeholder = "Check-in — Check-out";
    fp.close();
    fp.redraw();
  }
  document.getElementById('checkin').value = '';
  document.getElementById('checkout').value = '';
}

function resetPhoneCountryCodeToDefault() {
  const countryDisplay = document.querySelector('.country-display');
  const countryCodeInput = document.getElementById('countryCode');
  const phoneInput = document.getElementById('phone');

  if (countryDisplay) {
    countryDisplay.innerHTML = `
      <span class="iconify" data-icon="flag:gr-4x3" data-width="20" data-height="15"></span>
      <strong>+30</strong>
    `;
  }
  if (countryCodeInput) countryCodeInput.value = "+30";
  if (phoneInput) phoneInput.value = "";
}

function closeModalAndResetForm() {
  resetDates();
  modal.style.display = "none";

  if (bookingForm && bookingBtn) {
    bookingForm.style.display = "none";
    bookingForm.querySelector("form").reset();
    bookingBtn.textContent = "Booking Request";

    const messageBox = document.getElementById("message");
    const wordCountDisplay = document.getElementById("wordCount");
    if (messageBox) messageBox.value = "";
    if (wordCountDisplay) {
      wordCountDisplay.textContent = "Words: 0 / 500";
      wordCountDisplay.style.display = "none";
    }
  }

  resetRoomSelectionToDefault();

  document.getElementById('orderSummary').style.display = 'none';
  document.getElementById('osRoom').textContent = '-';
  document.getElementById('osGuests').textContent = '-';
  document.getElementById('osCheckin').textContent = '-';
  document.getElementById('osCheckout').textContent = '-';
  document.getElementById('osNights').textContent = '-';
  document.getElementById('osPrice').textContent = '-';
  document.getElementById('osTotal').textContent = '-';
  document.getElementById('roomType').value = '';
  document.getElementById('roomPrice').value = '';
  document.getElementById('checkin').value = '';
  document.getElementById('checkout').value = '';
  document.getElementById('guests').value = '1';

  const cf = document.getElementById('cfCaptcha');
  if (cf) cf.innerHTML = '';
  const tok = document.getElementById('captchaToken');
  if (tok) tok.value = '';
  captchaRendered = false;
}

function bindControls() {
  document.querySelectorAll('.plus, .minus').forEach(btn => {
    btn.onclick = () => {
      const roomId = parseInt(btn.dataset.room, 10);
      const type = btn.dataset.type; // 'adults' or 'children'
      const room = rooms.find(r => r.id === roomId);
      if (!room) return;

      if (btn.classList.contains('plus')) {
        if (!canIncrement(room, type)) {
          showCapacityNotice(room);
          return;
        }
        room[type]++;
      } else {
        const min = (type === 'adults') ? 1 : 0;
        if (room[type] > min) room[type]--;
      }

      const span = document.getElementById(`${type}-${roomId}`);
      if (span) span.textContent = room[type];

      if (type === 'children') setInfantVisibility(roomId);

      updateSummary();
      updateOrderSummary();
    };
  });

  document.querySelectorAll('.room-type-select').forEach(select => {
    select.onchange = () => {
      const roomId = parseInt(select.dataset.room, 10);
      const room = rooms.find(r => r.id === roomId);
      if (!room) return;
      room.type = select.value;

      const changed = enforceRoomCapacity(room);
      if (changed) {
        const aEl = document.getElementById(`adults-${roomId}`);
        const cEl = document.getElementById(`children-${roomId}`);
        if (aEl) aEl.textContent = room.adults;
        if (cEl) cEl.textContent = room.children;
      }
      setInfantVisibility(roomId);
      updateSummary();
      updateOrderSummary();
    };
  });
}

function addRoomHandler() {
  if (rooms.length >= 2) {
    setTimeout(() => {
      const addRoomBtn = document.getElementById('addRoom');
      if (addRoomBtn) addRoomBtn.remove();
    }, 10);
    roomsContainer.insertAdjacentHTML('afterend', `
      <div id="roomLimitMsg" style="margin-top: 10px; font-weight: 500;">
        To add more than 2 rooms, please call <a href="tel:+302104949930" style="color:#673131;">+30 210 494 9930</a> or <a href="contact.html" style="color:#673131;">contact us</a>.
      </div>`);
    return;
  }
  const roomId = nextRoomId++;
  rooms.push({ id: roomId, adults: 1, children: 0, type: allowedRoomTypes[0], infantUnder2: false });
  const roomTypeOptions = allowedRoomTypes.map(type =>
    `<option value="${type}" ${type === allowedRoomTypes[0] ? 'selected' : ''}>${type.replace(" Room", "")}</option>`
  ).join("");
  const roomHTML = `
    <div class="room room-block" data-room="${roomId}" id="room-${roomId}" style="padding: 0.5rem;">
      <div style="position: relative; text-align: center; margin-bottom: 0.5rem;">
        <h4 class="guest-toggle-room-title" style="margin: 0; font-weight: 600; font-size: 1rem;">Room ${rooms.length}</h4>
        <button class="remove-room-btn" data-room="${roomId}" title="Remove Room" style="position: absolute; right: 0; top: 0; font-size: 1.2rem; background: none; border: none; color: #333; cursor: pointer;">&times;</button>
      </div>
      <div class="guest-row">
        <span>Room Type</span>
        <select class="room-type-select" data-room="${roomId}" id="room-type-${roomId}" style="padding: 4px 13px; border-radius: 6px;">
          ${roomTypeOptions}
        </select>
      </div>
      <div class="guest-row">
        <span>Adults (18+)</span>
        <div>
          <button type="button" class="minus" data-room="${roomId}" data-type="adults" style="width: 32px;">–</button>
          <span id="adults-${roomId}" style="margin: 0 10px;">1</span>
          <button type="button" class="plus" data-room="${roomId}" data-type="adults" style="width: 32px;">+</button>
        </div>
      </div>
      <div class="guest-row">
        <span>Children</span>
        <div>
          <button type="button" class="minus" data-room="${roomId}" data-type="children" style="width: 32px;">–</button>
          <span id="children-${roomId}" style="margin: 0 10px;">0</span>
          <button type="button" class="plus" data-room="${roomId}" data-type="children" style="width: 32px;">+</button>
        </div>
      </div>
      <div class="guest-row infant-row">
        <span class="label">Infant (under 2)</span>
        <div class="control">
          <input type="checkbox" class="infant-checkbox" data-room="${roomId}" aria-label="Infant (under 2)">
        </div>
      </div>
    </div>
  `;
  roomsContainer.insertAdjacentHTML('beforeend', roomHTML);
  bindControls();
  updateSummary();
  updateRoomTitles();
  updateOrderSummary();
  setInfantVisibility(roomId);
}

// ---- Capacity rules + toast helpers ----
const ROOM_CAPACITY = {
  "Economy Room": { maxTotal: 2, maxChildren: 1, msg: "Economy Room max capacity is 2 Guests." },
  "Single Room": { maxTotal: 1, maxChildren: 0, msg: "Single Room max capacity is 1 Guest." },
  "Deluxe Room":   { maxTotal: 3, maxChildren: 2, msg: "Deluxe Room max capacity is 3 Guests." },
  "Double Room": { maxTotal: 2, maxChildren: 1, msg: "Double Room max capacity is 2 Guests." },
};

const capacityToastTimers = {};

function getCapacityForRoomType(type) {
  return ROOM_CAPACITY[type] || { maxTotal: Infinity, maxChildren: Infinity, msg: "" };
}

function canIncrement(room, typeToInc) {
  const caps = getCapacityForRoomType(room.type);
  const newAdults   = typeToInc === 'adults'   ? room.adults + 1   : room.adults;
  const newChildren = typeToInc === 'children' ? room.children + 1 : room.children;

  if (newChildren > caps.maxChildren) return false;
  if (newAdults + newChildren > caps.maxTotal) return false;
  return true;
}

function enforceRoomCapacity(room, {quiet=false} = {}) {
  const caps = getCapacityForRoomType(room.type);
  let changed = false;

  if (room.children > caps.maxChildren) {
    room.children = caps.maxChildren;
    changed = true;
  }

  if (room.adults + room.children > caps.maxTotal) {
    const allowedAdults = Math.max(1, caps.maxTotal - room.children);
    if (room.adults > allowedAdults) {
      room.adults = allowedAdults;
      changed = true;
    } else {
      const allowedChildren = Math.max(0, caps.maxTotal - room.adults);
      if (room.children > allowedChildren) {
        room.children = allowedChildren;
        changed = true;
      }
    }
  }

  if (changed && !quiet) showCapacityNotice(room);
  return changed;
}

function showCapacityNotice(room) {
  const caps = getCapacityForRoomType(room.type);
  const panel = document.getElementById('guestPanel');
  if (!panel) return;

  let banner = panel.querySelector('.capacity-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'capacity-banner';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML = `
      <i class="fa-solid fa-circle-info" aria-hidden="true"></i>
      <span class="capacity-text"></span>
      <button type="button" class="capacity-close" aria-label="Dismiss">&times;</button>
    `;
    panel.insertAdjacentElement('afterbegin', banner);
    banner.querySelector('.capacity-close')
      .addEventListener('click', () => hideCapacityBanner(banner));
    requestAnimationFrame(() => banner.classList.add('show'));
  }
  banner.querySelector('.capacity-text').textContent = caps.msg;

  clearTimeout(capacityToastTimers.global);
  capacityToastTimers.global = setTimeout(() => hideCapacityBanner(banner), 3000);
}

function hideCapacityBanner(banner) {
  if (!banner) return;
  banner.classList.remove('show');
  setTimeout(() => banner.remove(), 180);
}

roomsContainer?.addEventListener('change', (e) => {
  if (e.target.classList.contains('infant-checkbox')) {
    const roomId = parseInt(e.target.dataset.room, 10);
    const room = rooms.find(r => r.id === roomId);
    if (room) room.infantUnder2 = e.target.checked;
    
    updateSummary();         
    updateOrderSummary(); 
  }
});

function setInfantVisibility(roomId) {
  const room = rooms.find(r => r.id === roomId);
  const row = document.querySelector(`#room-${roomId} .infant-row`);
  if (!room || !row) return;

  const show = (room.children || 0) > 0;
  row.style.display = show ? 'flex' : 'none';

  if (!show) {
    const cb = row.querySelector('.infant-checkbox');
    if (cb) cb.checked = false;
    if (room) room.infantUnder2 = false;
  }
}

// ========== Phone country selector (no OTP) ==========

// 253 countries
const countries = [
  { name: "Afghanistan", code: "AF", phone: 93 },
  { name: "Aland Islands", code: "AX", phone: 358 },
  { name: "Albania", code: "AL", phone: 355 },
  { name: "Algeria", code: "DZ", phone: 213 },
  { name: "American Samoa", code: "AS", phone: 1684 },
  { name: "Andorra", code: "AD", phone: 376 },
  { name: "Angola", code: "AO", phone: 244 },
  { name: "Anguilla", code: "AI", phone: 1264 },
  { name: "Antarctica", code: "AQ", phone: 672 },
  { name: "Antigua and Barbuda", code: "AG", phone: 1268 },
  { name: "Argentina", code: "AR", phone: 54 },
  { name: "Armenia", code: "AM", phone: 374 },
  { name: "Aruba", code: "AW", phone: 297 },
  { name: "Australia", code: "AU", phone: 61 },
  { name: "Austria", code: "AT", phone: 43 },
  { name: "Azerbaijan", code: "AZ", phone: 994 },
  { name: "Bahamas", code: "BS", phone: 1242 },
  { name: "Bahrain", code: "BH", phone: 973 },
  { name: "Bangladesh", code: "BD", phone: 880 },
  { name: "Barbados", code: "BB", phone: 1246 },
  { name: "Belarus", code: "BY", phone: 375 },
  { name: "Belgium", code: "BE", phone: 32 },
  { name: "Belize", code: "BZ", phone: 501 },
  { name: "Benin", code: "BJ", phone: 229 },
  { name: "Bermuda", code: "BM", phone: 1441 },
  { name: "Bhutan", code: "BT", phone: 975 },
  { name: "Bolivia", code: "BO", phone: 591 },
  { name: "Bonaire, Sint Eustatius and Saba", code: "BQ", phone: 599 },
  { name: "Bosnia and Herzegovina", code: "BA", phone: 387 },
  { name: "Botswana", code: "BW", phone: 267 },
  { name: "Bouvet Island", code: "BV", phone: 55 },
  { name: "Brazil", code: "BR", phone: 55 },
  { name: "British Indian Ocean Territory", code: "IO", phone: 246 },
  { name: "Brunei Darussalam", code: "BN", phone: 673 },
  { name: "Bulgaria", code: "BG", phone: 359 },
  { name: "Burkina Faso", code: "BF", phone: 226 },
  { name: "Burundi", code: "BI", phone: 257 },
  { name: "Cambodia", code: "KH", phone: 855 },
  { name: "Cameroon", code: "CM", phone: 237 },
  { name: "Canada", code: "CA", phone: 1 },
  { name: "Cape Verde", code: "CV", phone: 238 },
  { name: "Cayman Islands", code: "KY", phone: 1345 },
  { name: "Central African Republic", code: "CF", phone: 236 },
  { name: "Chad", code: "TD", phone: 235 },
  { name: "Chile", code: "CL", phone: 56 },
  { name: "China", code: "CN", phone: 86 },
  { name: "Christmas Island", code: "CX", phone: 61 },
  { name: "Cocos (Keeling) Islands", code: "CC", phone: 672 },
  { name: "Colombia", code: "CO", phone: 57 },
  { name: "Comoros", code: "KM", phone: 269 },
  { name: "Congo", code: "CG", phone: 242 },
  { name: "Congo, Democratic Republic of the Congo", code: "CD", phone: 242 },
  { name: "Cook Islands", code: "CK", phone: 682 },
  { name: "Costa Rica", code: "CR", phone: 506 },
  { name: "Cote D'Ivoire", code: "CI", phone: 225 },
  { name: "Croatia", code: "HR", phone: 385 },
  { name: "Cuba", code: "CU", phone: 53 },
  { name: "Curacao", code: "CW", phone: 599 },
  { name: "Cyprus", code: "CY", phone: 357 },
  { name: "Czech Republic", code: "CZ", phone: 420 },
  { name: "Denmark", code: "DK", phone: 45 },
  { name: "Djibouti", code: "DJ", phone: 253 },
  { name: "Dominica", code: "DM", phone: 1767 },
  { name: "Dominican Republic", code: "DO", phone: 1809 },
  { name: "Ecuador", code: "EC", phone: 593 },
  { name: "Egypt", code: "EG", phone: 20 },
  { name: "El Salvador", code: "SV", phone: 503 },
  { name: "Equatorial Guinea", code: "GQ", phone: 240 },
  { name: "Eritrea", code: "ER", phone: 291 },
  { name: "Estonia", code: "EE", phone: 372 },
  { name: "Ethiopia", code: "ET", phone: 251 },
  { name: "Falkland Islands (Malvinas)", code: "FK", phone: 500 },
  { name: "Faroe Islands", code: "FO", phone: 298 },
  { name: "Fiji", code: "FJ", phone: 679 },
  { name: "Finland", code: "FI", phone: 358 },
  { name: "France", code: "FR", phone: 33 },
  { name: "French Guiana", code: "GF", phone: 594 },
  { name: "French Polynesia", code: "PF", phone: 689 },
  { name: "French Southern Territories", code: "TF", phone: 262 },
  { name: "Gabon", code: "GA", phone: 241 },
  { name: "Gambia", code: "GM", phone: 220 },
  { name: "Georgia", code: "GE", phone: 995 },
  { name: "Germany", code: "DE", phone: 49 },
  { name: "Ghana", code: "GH", phone: 233 },
  { name: "Gibraltar", code: "GI", phone: 350 },
  { name: "Greece", code: "GR", phone: 30 },
  { name: "Greenland", code: "GL", phone: 299 },
  { name: "Grenada", code: "GD", phone: 1473 },
  { name: "Guadeloupe", code: "GP", phone: 590 },
  { name: "Guam", code: "GU", phone: 1671 },
  { name: "Guatemala", code: "GT", phone: 502 },
  { name: "Guernsey", code: "GG", phone: 44 },
  { name: "Guinea", code: "GN", phone: 224 },
  { name: "Guinea-Bissau", code: "GW", phone: 245 },
  { name: "Guyana", code: "GY", phone: 592 },
  { name: "Haiti", code: "HT", phone: 509 },
  { name: "Heard Island and McDonald Islands", code: "HM", phone: 0 },
  { name: "Holy See (Vatican City State)", code: "VA", phone: 39 },
  { name: "Honduras", code: "HN", phone: 504 },
  { name: "Hong Kong", code: "HK", phone: 852 },
  { name: "Hungary", code: "HU", phone: 36 },
  { name: "Iceland", code: "IS", phone: 354 },
  { name: "India", code: "IN", phone: 91 },
  { name: "Indonesia", code: "ID", phone: 62 },
  { name: "Iran, Islamic Republic of", code: "IR", phone: 98 },
  { name: "Iraq", code: "IQ", phone: 964 },
  { name: "Ireland", code: "IE", phone: 353 },
  { name: "Isle of Man", code: "IM", phone: 44 },
  { name: "Israel", code: "IL", phone: 972 },
  { name: "Italy", code: "IT", phone: 39 },
  { name: "Jamaica", code: "JM", phone: 1876 },
  { name: "Japan", code: "JP", phone: 81 },
  { name: "Jersey", code: "JE", phone: 44 },
  { name: "Jordan", code: "JO", phone: 962 },
  { name: "Kazakhstan", code: "KZ", phone: 7 },
  { name: "Kenya", code: "KE", phone: 254 },
  { name: "Kiribati", code: "KI", phone: 686 },
  { name: "Korea, Democratic People's Republic of", code: "KP", phone: 850 },
  { name: "Korea, Republic of", code: "KR", phone: 82 },
  { name: "Kosovo", code: "XK", phone: 383 },
  { name: "Kuwait", code: "KW", phone: 965 },
  { name: "Kyrgyzstan", code: "KG", phone: 996 },
  { name: "Lao People's Democratic Republic", code: "LA", phone: 856 },
  { name: "Latvia", code: "LV", phone: 371 },
  { name: "Lebanon", code: "LB", phone: 961 },
  { name: "Lesotho", code: "LS", phone: 266 },
  { name: "Liberia", code: "LR", phone: 231 },
  { name: "Libyan Arab Jamahiriya", code: "LY", phone: 218 },
  { name: "Liechtenstein", code: "LI", phone: 423 },
  { name: "Lithuania", code: "LT", phone: 370 },
  { name: "Luxembourg", code: "LU", phone: 352 },
  { name: "Macao", code: "MO", phone: 853 },
  { name: "Macedonia, the Former Yugoslav Republic of", code: "MK", phone: 389 },
  { name: "Madagascar", code: "MG", phone: 261 },
  { name: "Malawi", code: "MW", phone: 265 },
  { name: "Malaysia", code: "MY", phone: 60 },
  { name: "Maldives", code: "MV", phone: 960 },
  { name: "Mali", code: "ML", phone: 223 },
  { name: "Malta", code: "MT", phone: 356 },
  { name: "Marshall Islands", code: "MH", phone: 692 },
  { name: "Martinique", code: "MQ", phone: 596 },
  { name: "Mauritania", code: "MR", phone: 222 },
  { name: "Mauritius", code: "MU", phone: 230 },
  { name: "Mayotte", code: "YT", phone: 262 },
  { name: "Mexico", code: "MX", phone: 52 },
  { name: "Micronesia, Federated States of", code: "FM", phone: 691 },
  { name: "Moldova, Republic of", code: "MD", phone: 373 },
  { name: "Monaco", code: "MC", phone: 377 },
  { name: "Mongolia", code: "MN", phone: 976 },
  { name: "Montenegro", code: "ME", phone: 382 },
  { name: "Montserrat", code: "MS", phone: 1664 },
  { name: "Morocco", code: "MA", phone: 212 },
  { name: "Mozambique", code: "MZ", phone: 258 },
  { name: "Myanmar", code: "MM", phone: 95 },
  { name: "Namibia", code: "NA", phone: 264 },
  { name: "Nauru", code: "NR", phone: 674 },
  { name: "Nepal", code: "NP", phone: 977 },
  { name: "Netherlands", code: "NL", phone: 31 },
  { name: "Netherlands Antilles", code: "AN", phone: 599 },
  { name: "New Caledonia", code: "NC", phone: 687 },
  { name: "New Zealand", code: "NZ", phone: 64 },
  { name: "Nicaragua", code: "NI", phone: 505 },
  { name: "Niger", code: "NE", phone: 227 },
  { name: "Nigeria", code: "NG", phone: 234 },
  { name: "Niue", code: "NU", phone: 683 },
  { name: "Norfolk Island", code: "NF", phone: 672 },
  { name: "Northern Mariana Islands", code: "MP", phone: 1670 },
  { name: "Norway", code: "NO", phone: 47 },
  { name: "Oman", code: "OM", phone: 968 },
  { name: "Pakistan", code: "PK", phone: 92 },
  { name: "Palau", code: "PW", phone: 680 },
  { name: "Palestinian Territory, Occupied", code: "PS", phone: 970 },
  { name: "Panama", code: "PA", phone: 507 },
  { name: "Papua New Guinea", code: "PG", phone: 675 },
  { name: "Paraguay", code: "PY", phone: 595 },
  { name: "Peru", code: "PE", phone: 51 },
  { name: "Philippines", code: "PH", phone: 63 },
  { name: "Pitcairn", code: "PN", phone: 64 },
  { name: "Poland", code: "PL", phone: 48 },
  { name: "Portugal", code: "PT", phone: 351 },
  { name: "Puerto Rico", code: "PR", phone: 1787 },
  { name: "Qatar", code: "QA", phone: 974 },
  { name: "Reunion", code: "RE", phone: 262 },
  { name: "Romania", code: "RO", phone: 40 },
  { name: "Russian Federation", code: "RU", phone: 7 },
  { name: "Rwanda", code: "RW", phone: 250 },
  { name: "Saint Barthelemy", code: "BL", phone: 590 },
  { name: "Saint Helena", code: "SH", phone: 290 },
  { name: "Saint Kitts and Nevis", code: "KN", phone: 1869 },
  { name: "Saint Lucia", code: "LC", phone: 1758 },
  { name: "Saint Martin", code: "MF", phone: 590 },
  { name: "Saint Pierre and Miquelon", code: "PM", phone: 508 },
  { name: "Saint Vincent and the Grenadines", code: "VC", phone: 1784 },
  { name: "Samoa", code: "WS", phone: 684 },
  { name: "San Marino", code: "SM", phone: 378 },
  { name: "Sao Tome and Principe", code: "ST", phone: 239 },
  { name: "Saudi Arabia", code: "SA", phone: 966 },
  { name: "Senegal", code: "SN", phone: 221 },
  { name: "Serbia", code: "RS", phone: 381 },
  { name: "Serbia and Montenegro", code: "CS", phone: 381 },
  { name: "Seychelles", code: "SC", phone: 248 },
  { name: "Sierra Leone", code: "SL", phone: 232 },
  { name: "Singapore", code: "SG", phone: 65 },
  { name: "St Martin", code: "SX", phone: 721 },
  { name: "Slovakia", code: "SK", phone: 421 },
  { name: "Slovenia", code: "SI", phone: 386 },
  { name: "Solomon Islands", code: "SB", phone: 677 },
  { name: "Somalia", code: "SO", phone: 252 },
  { name: "South Africa", code: "ZA", phone: 27 },
  { name: "South Georgia and the South Sandwich Islands", code: "GS", phone: 500 },
  { name: "South Sudan", code: "SS", phone: 211 },
  { name: "Spain", code: "ES", phone: 34 },
  { name: "Sri Lanka", code: "LK", phone: 94 },
  { name: "Sudan", code: "SD", phone: 249 },
  { name: "Suriname", code: "SR", phone: 597 },
  { name: "Svalbard and Jan Mayen", code: "SJ", phone: 47 },
  { name: "Swaziland", code: "SZ", phone: 268 },
  { name: "Sweden", code: "SE", phone: 46 },
  { name: "Switzerland", code: "CH", phone: 41 },
  { name: "Syrian Arab Republic", code: "SY", phone: 963 },
  { name: "Taiwan, Province of China", code: "TW", phone: 886 },
  { name: "Tajikistan", code: "TJ", phone: 992 },
  { name: "Tanzania, United Republic of", code: "TZ", phone: 255 },
  { name: "Thailand", code: "TH", phone: 66 },
  { name: "Timor-Leste", code: "TL", phone: 670 },
  { name: "Togo", code: "TG", phone: 228 },
  { name: "Tokelau", code: "TK", phone: 690 },
  { name: "Tonga", code: "TO", phone: 676 },
  { name: "Trinidad and Tobago", code: "TT", phone: 1868 },
  { name: "Tunisia", code: "TN", phone: 216 },
  { name: "Turkey", code: "TR", phone: 90 },
  { name: "Turkmenistan", code: "TM", phone: 7370 },
  { name: "Turks and Caicos Islands", code: "TC", phone: 1649 },
  { name: "Tuvalu", code: "TV", phone: 688 },
  { name: "Uganda", code: "UG", phone: 256 },
  { name: "Ukraine", code: "UA", phone: 380 },
  { name: "United Arab Emirates", code: "AE", phone: 971 },
  { name: "United Kingdom", code: "GB", phone: 44 },
  { name: "United States", code: "US", phone: 1 },
  { name: "United States Minor Outlying Islands", code: "UM", phone: 1 },
  { name: "Uruguay", code: "UY", phone: 598 },
  { name: "Uzbekistan", code: "UZ", phone: 998 },
  { name: "Vanuatu", code: "VU", phone: 678 },
  { name: "Venezuela", code: "VE", phone: 58 },
  { name: "Viet Nam", code: "VN", phone: 84 },
  { name: "Virgin Islands, British", code: "VG", phone: 1284 },
  { name: "Virgin Islands, U.s.", code: "VI", phone: 1340 },
  { name: "Wallis and Futuna", code: "WF", phone: 681 },
  { name: "Western Sahara", code: "EH", phone: 212 },
  { name: "Yemen", code: "YE", phone: 967 },
  { name: "Zambia", code: "ZM", phone: 260 },
  { name: "Zimbabwe", code: "ZW", phone: 263 }
],
  select_box = document.querySelector('.options'),
  search_box = document.querySelector('.search-box'),
  input_box = document.querySelector('input[type="tel"]'),
  selected_option = document.querySelector('.selected-option div');

let options = null;

for (country of countries) {
  const option = `
    <li class="option">
      <div>
        <span class="iconify" data-icon="flag:${country.code.toLowerCase()}-4x3"></span>
        <span class="country-name">${country.name}</span>
      </div>
      <strong>+${country.phone}</strong>
    </li> `;
  select_box?.querySelector('ol').insertAdjacentHTML('beforeend', option);
  options = document.querySelectorAll('.option');
}

function selectOption() {
  const icon = this.querySelector('.iconify').cloneNode(true);
  const phone_code = this.querySelector('strong').textContent;

  selected_option.innerHTML = '';
  selected_option.append(icon);
  selected_option.insertAdjacentHTML('beforeend', `<strong>${phone_code}</strong>`);

  // Update hidden input with the selected country code
  const countryCodeInput = document.getElementById('countryCode');
  if (countryCodeInput) countryCodeInput.value = phone_code;

  select_box.classList.remove('active');
  selected_option.classList.remove('active');

  search_box.value = '';
  select_box.querySelectorAll('.hide').forEach(el => el.classList.remove('hide'));
}

function searchCountry() {
  let search_query = search_box.value.toLowerCase();
  for (option of options) {
    let is_matched = option.querySelector('.country-name').innerText.toLowerCase().includes(search_query);
    option.classList.toggle('hide', !is_matched)
  }
}

selected_option?.addEventListener('click', () => {
  select_box.classList.toggle('active');
  selected_option.classList.toggle('active');
  const fullPhone = (document.getElementById('countryCode')?.value || '+30') + input_box.value;
  console.log("Submitting phone number:", fullPhone);
});

options?.forEach(option => option.addEventListener('click', selectOption));
search_box?.addEventListener('input', searchCountry);

if (select_box && selected_option) {
  document.addEventListener('click', (e) => {
    const clickedInside =
      select_box.contains(e.target) || selected_option.contains(e.target);

    if (!clickedInside) {
      select_box.classList.remove('active');
      selected_option.classList.remove('active');
    }
  });
}

// ========== Message word counter (robust) ==========
(() => {
  const box = document.getElementById('message');
  const counter = document.getElementById('wordCount');
  const MAX = 200;
  if (!box || !counter) return;

  const update = () => {
    // split -> filter(Boolean) handles multiple spaces/newlines
    const words = box.value.trim().split(/\s+/).filter(Boolean);
    const count = words.length;

    // show/hide
    if (count === 0) {
      counter.style.display = 'none';
      counter.textContent = `Words: 0 / ${MAX}`;
      return;
    }
    counter.style.display = 'inline';

    // enforce limit without being janky
    if (count > MAX) {
      const trimmed = words.slice(0, MAX).join(' ');
      const atEnd =
        box.selectionStart === box.value.length &&
        box.selectionEnd === box.value.length;
      box.value = trimmed + ' '; // keep a trailing space for nicer typing
      if (atEnd) box.selectionStart = box.selectionEnd = box.value.length;
      counter.textContent = `Words: ${MAX} / ${MAX}`;
      return;
    }

    counter.textContent = `Words: ${count} / ${MAX}`;
  };

  box.addEventListener('input', update);
  update(); // initialize
})();


function scrollToBookingButton() {
  const container = document.querySelector('.modal-content');
  const btn = container?.querySelector('.book-btn');
  if (!container || !btn) return;

  const delta =
    btn.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    16;

  container.scrollTo({
    top: container.scrollTop + delta,
    behavior: 'smooth'
  });

  setTimeout(() => btn.focus({ preventScroll: true }), 300);
}

function setInfantVisibility(roomId) {
  const room = rooms.find(r => r.id === roomId);
  const row  = document.querySelector(`#room-${roomId} .infant-row`);
  if (!room || !row) return;

  const show = (room.children || 0) > 0;
  row.classList.toggle('is-visible', show);

  if (!show) {
    const cb = row.querySelector('.infant-checkbox');
    if (cb) cb.checked = false;
    room.infantUnder2 = false;
  }
}

let firstErrorEl = null;

function scrollToFirstError() {
  if (!firstErrorEl) return;

  // scroll inside the modal content if present, else the page
  const container = document.querySelector('#roomModal .modal-content');
  const anchorCell = messageContainerFor(firstErrorEl) || firstErrorEl;

  if (container) {
    const delta =
      anchorCell.getBoundingClientRect().top -
      container.getBoundingClientRect().top - 24; // padding
    container.scrollTo({ top: container.scrollTop + delta, behavior: 'smooth' });
  } else {
    anchorCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // focus a sensible control
  const focusTarget =
    firstErrorEl.id === 'guests'   ? document.getElementById('guestToggle') :
    (firstErrorEl.id === 'checkin' || firstErrorEl.id === 'checkout' || firstErrorEl.id === 'dates')
                                   ? document.getElementById('dates')
                                   : firstErrorEl;

  setTimeout(() => focusTarget?.focus?.({ preventScroll: true }), 300);
}


// --- where to place each field's message (inside the same cell) ---
function messageContainerFor(elOrId){
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if(!el) return null;

  if(el.id === 'phone') return el.closest('.form-floating'); // composite phone block
  if(el.id === 'checkin' || el.id === 'checkout') return document.getElementById('dates').closest('.form-floating');
  if(el.id === 'guests') return document.querySelector('.guests-container');
  if(el.id === 'policy') return document.getElementById('policy').closest('label');

  if(el.id === 'captchaToken') return document.getElementById('captchaWrap');

  return el.closest('.form-floating') || el.parentElement;
}

function clearFieldError(elOrId){
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if(!el) return;

  el.classList.remove('field-error');
  if(el.id === 'phone') el.closest('.selected-option')?.classList.remove('field-error');
  if(el.id === 'captchaToken') document.getElementById('captchaWrap')?.classList.remove('field-error');

  const msg = document.getElementById(`err-${el.id}`);
  if(msg){ msg.classList.add('fade-out'); setTimeout(() => msg.remove(), 250); }

  if(el.getAttribute('aria-describedby') === `err-${el.id}`){
    el.removeAttribute('aria-describedby');
  }
}

function setFieldError(elOrId, text){
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  if (!el) return;

  if (!firstErrorEl) firstErrorEl = el;

  el.classList.add('field-error');
  if (el.id === 'phone') el.closest('.selected-option')?.classList.add('field-error');
  if (el.id === 'captchaToken') document.getElementById('captchaWrap')?.classList.add('field-error');

  const cell = messageContainerFor(el);
  if (!cell) return;
  document.getElementById(`err-${el.id}`)?.remove();
  const msg = document.createElement('div');
  msg.className = 'field-msg';
  msg.id = `err-${el.id}`;
  msg.setAttribute('role','status');
  msg.innerHTML = `<i class="fa-solid fa-circle-exclamation" aria-hidden="true"></i><span>${text}</span>`;
  cell.appendChild(msg);
  el.setAttribute('aria-describedby', msg.id);

  const clear = () => clearFieldError(el);
  el.addEventListener('input', clear, { once:true });
  el.addEventListener('change', clear, { once:true });
  setTimeout(clear, 4000);
}

function validateBookingForm() {
  // clear previous errors/messages
  document.querySelectorAll('.field-msg').forEach(n => n.remove());
  document.querySelectorAll('.field-error').forEach(n => n.classList.remove('field-error'));
  document.querySelectorAll('.selected-option.field-error').forEach(n => n.classList.remove('field-error'));
  firstErrorEl = null; // <-- reset the "first error" tracker

  let ok = true;

  // First / Last name
  const firstNameEl = document.getElementById('firstName');
  const lastNameEl  = document.getElementById('lastName');
  if (!firstNameEl.value.trim()) { setFieldError(firstNameEl, 'Please enter your first name.'); ok = false; }
  if (!lastNameEl.value.trim())  { setFieldError(lastNameEl,  'Please enter your last name.');  ok = false; }

  // Email
  const emailEl = document.getElementById('email');
  const email   = emailEl.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setFieldError(emailEl, 'Enter a valid email (name@example.com).');
    ok = false;
  }

  // Phone (allow spaces/dashes -> validate digits)
  const phoneEl     = document.getElementById('phone');
  const phoneDigits = phoneEl.value.replace(/\D/g, '');
  if (!/^\d{6,15}$/.test(phoneDigits)) {
    setFieldError(phoneEl, 'Enter a valid phone (6–15 digits).');
    ok = false;
  }

  // Dates (attach message to the visible Dates control)
  const ci = document.getElementById('checkin').value;
  const co = document.getElementById('checkout').value;
  if (!ci || !co) {
    setFieldError('dates', 'Choose your check-in and check-out dates.');
    ok = false;
  } else {
    const inDate  = new Date(ci);
    const outDate = new Date(co);
    if (!(outDate > inDate)) {
      setFieldError('dates', 'Check-out must be after check-in.');
      ok = false;
    }
  }

  // Guests (hidden input; message appears in .guests-container)
  const guestsEl = document.getElementById('guests');
  if (!guestsEl.value.trim()) {
    setFieldError('guests', 'Select room(s) and guests.');
    ok = false;
  }

  // Privacy Policy
  const policyEl = document.getElementById('policy');
  if (policyEl && !policyEl.checked) {
    setFieldError(policyEl, 'Please accept the Privacy Policy.');
    ok = false;
  }
  // Captcha
  const captchaVal =
    document.getElementById('captchaToken')?.value.trim() ||
    document.querySelector('input[name="cf-turnstile-response"]')?.value.trim() || '';

  if (!captchaVal) {
    setFieldError('captchaToken', 'Please complete the verification.');
    ok = false;
  }
  if (!ok) {
    scrollToFirstError();   // <-- smooth-scroll + focus
    return false;
  }
  return true;
}



// Turnstile -> we store the token and clear any prior error
window.onCaptchaVerified = (t) => {
  const el = document.getElementById('captchaToken');
  el.value = t;
  // clear any previous error styling/message
  clearFieldError(el);
  document.getElementById('captchaWrap')?.classList.remove('field-error');
};

window.onCaptchaExpired = () => {
  const el = document.getElementById('captchaToken');
  el.value = '';
  setFieldError(el, 'Please complete the verification again.');
  document.getElementById('captchaWrap')?.classList.add('field-error');
};



// ---- Progress pane refs & helpers ----
const modalContent  = document.querySelector('#roomModal .modal-content');
const modalProgress = document.getElementById('modalProgress');
const progressTitle = document.getElementById('progressTitle');
const progressSub   = document.getElementById('progressSubtitle');
const progressClose = document.getElementById('progressClose');
const progressAgain = document.getElementById('progressAgain');

function showModalLoading(title = 'Sending your request…', subtitle = 'Please wait a moment.') {
  if (!modal || !modalProgress) return;
  progressTitle.textContent = title;
  progressSub.textContent   = subtitle;

  modalProgress.classList.remove('success','error');
  modalProgress.setAttribute('aria-busy', 'true');
  modalProgress.hidden = false;

  // hide result buttons while we’re busy
  progressClose.hidden = true;
  progressAgain.hidden = true;

  // hide the normal content beneath
  modalContent.style.visibility = 'hidden';
  modal.classList.add('busy');
}

function showModalResult(kind = 'success', subtitle = '') {
  if (!modal || !modalProgress) return;

  const ok = kind === 'success';
  progressTitle.textContent = ok ? 'Your request has been sent!' : 'Oops—something went wrong';
  progressSub.textContent   = subtitle || (ok
    ? 'Thank you! We’ll get back to you shortly.'
    : 'Please try again in a moment.');

  modalProgress.classList.remove('success','error');
  modalProgress.classList.add(kind);
  modalProgress.setAttribute('aria-busy', 'false');

  // show actions
  progressClose.hidden = false;
  progressAgain.hidden = false;
}

function hideModalProgress(restore = true) {
  if (!modal || !modalProgress) return;
  modalProgress.hidden = true;
  modal.classList.remove('busy');
  if (restore) modalContent.style.visibility = 'visible';
}

// Buttons inside the progress card
progressClose?.addEventListener('click', () => {
  hideModalProgress(true);
  closeModalAndResetForm();
});

progressAgain?.addEventListener('click', () => {
  hideModalProgress(true);
  resetRoomSelectionToDefault();
});
