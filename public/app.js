document.addEventListener('DOMContentLoaded', function() {

    let app = firebase.app();

    fetch('http://localhost:5001/plan-simply-dmdev/us-central1/api/dog').then(document.write);

});