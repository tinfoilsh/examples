package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		message := os.Getenv("MESSAGE")
		if message == "" {
			message = "(unset)"
		}
		token := "absent"
		if os.Getenv("GREETING_TOKEN") != "" {
			token = "present"
		}
		fmt.Fprintf(w, "MESSAGE: %s\nGREETING_TOKEN: %s\n", message, token)
	})

	addr := ":8080"
	log.Printf("listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}
