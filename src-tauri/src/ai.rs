use futures_util::Stream;
use std::pin::Pin;

// A helper type alias to make writing async streams much cleaner.
// BoxStream holds a stream of items of type T.
pub type BoxStream<T> = Pin<Box<dyn Stream<Item = T> + Send>>;

// Our standardized AI blueprint
pub trait AiProvider: Send + Sync {
    // This function takes a prompt string slice (&str) and returns
    // a stream of Results. Each item yielded by the stream is either:
    // - Ok(String): The next word token from the AI.
    // - Err(String): A text error message if something fails.
    fn stream_chat(&self, prompt: &str) -> BoxStream<Result<String, String>>;
}
