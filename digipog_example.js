// Connect to Formbar WS API
const io = require('socket.io-client');
// Replace this address with the address of the Formbar you want to use.
const socket = io("https://formbeta.yorktechapps.com/", {
    extraHeaders: {
        api: "<API KEY HERE>"
    }
});

// Example Data Object
const data = {
    from: 1,
    to: 97,
    amount: 10,
    reason: "test",
    pin: 6969
}

// Wait for successful connection
socket.on("connect", () => {
    console.log("Connected to server");
    // Send the transfer
    socket.emit("transferDigipogs", data);
});

// Check the transfer response
socket.on("transferResponse", (response) => {
    console.log("Transfer Response:", response);
    // response will be: { success: true/false, message: "..." }
});