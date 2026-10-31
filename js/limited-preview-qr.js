/* QR code for the public Limited Preview page, shown in the left menu at the end
 * of the Home section (after "Limited Preview" and "Demo Video"), on that
 * section's pages. The code is images/limited-preview-qr.svg (segno 1.6.6,
 * error correction M); css/extra.css sizes it and leaves it out where the menu
 * becomes a drawer. */
(function () {
  "use strict";

  var PAGE = "content/overview/limited-preview-announcement/";
  var IMAGE = "images/limited-preview-qr.svg";
  var root = new URL("../", document.currentScript.src);
  var target = new URL(PAGE, root).pathname;

  function addQr() {
    var links = document.querySelectorAll(".md-nav--primary a.md-nav__link");
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute("href");
      var url = href && new URL(href, window.location.href);
      // The page's own entry only: on that page Material also puts its table of
      // contents in this menu, as "#section" links to the same path.
      if (!url || url.hash || url.pathname !== target) {
        continue;
      }
      // An entry of its own at the end of the section's list, so the entries
      // after "Limited Preview" stay next to it.
      var item = links[i].closest(".md-nav__item");
      var list = item && item.parentElement;
      if (!list || list.querySelector(":scope > .lp-qr")) {
        continue;
      }
      var box = document.createElement("li");
      box.className = "md-nav__item lp-qr";
      var img = document.createElement("img");
      img.src = new URL(IMAGE, root).href;
      img.alt = "QR code for the Limited Preview page";
      var caption = document.createElement("span");
      caption.textContent = "Scan to open the Limited Preview page";
      box.appendChild(img);
      box.appendChild(caption);
      list.appendChild(box);
    }
  }

  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(addQr);
  } else {
    addQr();
  }
})();
