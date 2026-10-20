/** Shared lifecycle interface for an atomic semantic unit or a composed group. */
export interface TrainableSemanticUnit<Input, Output, InferenceResources, TrainingInput, Candidate, TrainingResources> {
  infer(input: Input, resources: InferenceResources): Promise<Output>;
  train(input: TrainingInput, resources: TrainingResources): Promise<Candidate>;
}
