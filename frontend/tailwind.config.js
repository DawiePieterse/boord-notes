// Only the classes index.html and app.js actually use end up in
// shared/tailwind.css - see scripts/build_css.sh.
module.exports = {
  content: ["./app/index.html", "./app/app.js"],
};
